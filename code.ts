console.clear();

// These group names will be mapped in the generated variables file. null group
// names will be skipped. For example, this means Themable/Dark/Pink/10 will be
// exported as color.dark.pink[10] in the JSON and
// Semantic/Dialogs-and-modals/Divider will be color.dialog.divider
const MAP_GROUP_NAMES = {
  'Dialogs-and-modals': 'Dialogs',
  'Semantic': null,
  'Themable': null
}

interface Collection {
  id: string,
  variableIds: string[],
  name: string,
  remote?: boolean,
  modes: {
    modeId: string
    name: string
  }[]
}

function sanitizeName(name: string) {
  if (name === 'referencedVariable') return name
  return name.toLowerCase() // Names should be lower case
    .replace('%', '') // Don't export % in the names
    .replace(/[^a-zA-Z0-9-.]/g, '-') // Any special characters should be replaced with a -
    .replace(/(--+)|(^-)/, '-') // Replace multiple `-`s with a single `-`
    .replace(/^-/g, '') // Remove leading `-`
}

const getVariableAlias = (reference: Variable) => reference.name
  .split(/\//g)
  .map(r => {
    if (r in MAP_GROUP_NAMES) return MAP_GROUP_NAMES[r]
    return r
  })
  .filter(r => r !== null)
  .map(sanitizeName)
  .join('.')

async function exportToJSON() {
  const collections: Collection[] = []
  try {
    const v = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()
    const remoteCollections = await Promise.all(v.map(async c => {
      const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key);
      const result: Collection = {
        id: c.libraryName,
        name: c.name,
        variableIds: variables.map(v => v.key),
        modes: [{ modeId: 'default', name: 'Default' }],
        remote: true
      }
      return result
    }))
    collections.push(...remoteCollections)
  } catch (err: any) {
    console.error(err)
  }

  collections.push(...figma.variables.getLocalVariableCollections());

  // We go to a bit of effort to get our tokens into a format that styled-tokens
  // will understand. All color sets belong under a top level 'color' heading.
  // There is no easy way to determine if a set is for colors, so we check to
  // see if the set name contains the word 'color'. High tech, I know :D
  // Similarly, easing and duration/timing collections get their own top-level keys.
  const processedCollections = await Promise.all(collections.map(c => processCollection(c)))
  const result = processedCollections.reduce((prev, next) => {
    let target = prev
    const lowerName = next.name.toLowerCase()
    if (lowerName.includes('color')) {
      target = prev.color ?? (prev.color = {})
    } else if (lowerName.includes('easing')) {
      target = prev.easing ?? (prev.easing = {})
    } else if (lowerName.includes('timing') || lowerName.includes('duration')) {
      target = prev.duration ?? (prev.duration = {})
    }
    Object.assign(target, next.result)
    return prev
  }, {} as any)

  const sorted = Object.keys(result).sort().reduce((prev, next) => ({ ...prev, [next]: result[next] }), {})
  const sanitized = JSON.parse(JSON.stringify(sorted, (key, value) => {
    if (value && typeof value === "object") {
      return Object.entries(value).reduce((prev, [key, value]) => ({
        ...prev,
        [sanitizeName(key)]: value
      }), {})
    }
    return value
  }))

  figma.ui.postMessage({ type: "EXPORT_RESULT", result: sanitized });
}

const getVariableValue = async (variable: VariableValue, modeId: string) => {
  if (typeof variable === 'object' && ('type' in variable) && variable.type === "VARIABLE_ALIAS") {
    const aliased = await figma.variables.getVariableById(variable.id)

    // If we have a mode in the alias which matches the mode of our variable, use that. Otherwise just take the first mode.
    const mode = aliased.valuesByMode[modeId] ?? Object.values(aliased.valuesByMode)[0]
    return getVariableValue(mode, modeId)
  }

  return variable
}

async function processCollection({ name, modes, variableIds, remote }: Collection) {
  const result = {}
  const onlyOneMode = modes.length === 1
  for (const mode of modes) {
    const target: any = onlyOneMode ? result : (result[mode.name] = {})
    for (const variableId of variableIds) {
      // Library variables need to be imported by key
      const method: (keyof typeof figma.variables) = remote ? 'importVariableByKeyAsync' : 'getVariableById'
      const { name, resolvedType, valuesByMode } = await figma.variables[method](variableId);
      const rt = resolvedType as string
      const value: any = valuesByMode[mode.modeId];
      if (value !== undefined && ["COLOR", "FLOAT", "TIMING", "EASING"].includes(rt)) {
        let obj: any = target;
        name.split("/").forEach((groupName) => {
          const mapping = MAP_GROUP_NAMES[groupName]
          if (mapping === null) {
            return
          }

          groupName = mapping ?? groupName
          obj[groupName] = obj[groupName] || {};
          obj = obj[groupName];
        });

        const typeMap: Record<string, string> = {
          COLOR: "color",
          FLOAT: "number",
          TIMING: "custom-duration",
          EASING: "custom-easing"
        }
        obj.type = typeMap[rt] ?? rt.toLowerCase();

        if (value.type === "VARIABLE_ALIAS") {
          const resolvedValue = await getVariableValue(value, mode.modeId)
          obj.value = formatVariableValue(rt, resolvedValue)

          const ref = figma.variables.getVariableById(value.id)
          obj.referencedVariable = `$${getVariableAlias(ref)}`
        } else {
          obj.value = formatVariableValue(rt, value)
        }
      }
    }
  }

  const maybeWrapped = name.toLowerCase().includes('typography')
    ? {
      typography: result
    }
    : result

  return {
    name,
    result: maybeWrapped
  }
}

figma.ui.onmessage = (e) => {
  if (e.type === "EXPORT") {
    return exportToJSON()
  }
};

figma.showUI(__html__, {
  width: 500,
  height: 500,
  themeColors: true
})

function rgbToHex({ r, g, b, a }) {
  if (a !== 1) {
    return `rgba(${[r, g, b]
      .map((n) => Math.round(n * 255))
      .join(", ")}, ${a.toFixed(4)})`;
  }
  const toHex = (value) => {
    const hex = Math.round(value * 255).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };

  const hex = [toHex(r), toHex(g), toHex(b)].join("");
  return `#${hex}`;
}

function formatVariableValue(resolvedType: string, value: any) {
  if (resolvedType === "COLOR") {
    return rgbToHex(value)
  }
  if (resolvedType === "TIMING") {
    return formatDuration(value)
  }
  if (resolvedType === "EASING") {
    return formatEasing(value)
  }
  return value
}

// Figma TIMING variables are in seconds; Leo expects millisecond CSS strings.
function formatDuration(seconds: number): string {
  return `${Math.round(seconds * 1000)}ms`
}

function formatBezierNumber(n: number): number {
  return parseFloat(n.toFixed(2))
}

function formatCubicBezier(x1: number, y1: number, x2: number, y2: number): string {
  const points = [x1, y1, x2, y2].map(formatBezierNumber)
  return `cubic-bezier(${points.join(", ")})`
}

// Figma easingType numeric presets when bezierValues are absent.
const EASING_TYPE_PRESETS: Record<number, [number, number, number, number]> = {
  0: [0.42, 0, 1, 1],       // EASE_IN
  1: [0, 0, 0.58, 1],       // EASE_OUT
  2: [0.42, 0, 0.58, 1],    // EASE_IN_AND_OUT
  3: [0, 0, 1, 1],          // LINEAR
  4: [0.6, -0.28, 0.735, 0.045], // EASE_IN_BACK
  5: [0.175, 0.885, 0.32, 1.275], // EASE_OUT_BACK
  6: [0.68, -0.55, 0.265, 1.55], // EASE_IN_AND_OUT_BACK
}

function formatEasing(value: any): string {
  if (typeof value !== "object" || value === null) {
    return String(value)
  }

  const bezier = value.bezierValues ?? value.beziervalues ?? value.easingFunctionCubicBezier
  if (bezier) {
    const x1 = bezier.p1x ?? bezier.x1
    const y1 = bezier.p1y ?? bezier.y1
    const x2 = bezier.p2x ?? bezier.x2
    const y2 = bezier.p2y ?? bezier.y2
    if ([x1, y1, x2, y2].every(n => typeof n === "number")) {
      return formatCubicBezier(x1, y1, x2, y2)
    }
  }

  const easingType = value.easingType ?? value.easingtype ?? value.type
  if (typeof easingType === "number" && easingType in EASING_TYPE_PRESETS) {
    return formatCubicBezier(...EASING_TYPE_PRESETS[easingType])
  }

  // String-typed presets from the documented Easing interface
  const namedPresets: Record<string, [number, number, number, number]> = {
    EASE_IN: EASING_TYPE_PRESETS[0],
    EASE_OUT: EASING_TYPE_PRESETS[1],
    EASE_IN_AND_OUT: EASING_TYPE_PRESETS[2],
    LINEAR: EASING_TYPE_PRESETS[3],
    EASE_IN_BACK: EASING_TYPE_PRESETS[4],
    EASE_OUT_BACK: EASING_TYPE_PRESETS[5],
    EASE_IN_AND_OUT_BACK: EASING_TYPE_PRESETS[6],
  }
  if (typeof easingType === "string" && easingType in namedPresets) {
    return formatCubicBezier(...namedPresets[easingType])
  }

  return formatCubicBezier(0, 0, 1, 1)
}
