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
  return name.toLowerCase() // Names should be lower case
    .replace('%', '') // Don't export % in the names
    .replace(/[^a-zA-Z0-9-.]/g, '-') // Any special characters should be replaced with a -
    .replace(/(--+)|(^-)/, '-') // Replace multiple `-`s with a single `-`
    .replace(/^-/g, '') // Remove leading `-`
}

const getVariableAlias = (reference: Variable) => reference.name
  .split(/\//g)
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
  const processedCollections = await Promise.all(collections.map(c => processCollection(c)))
  const result = processedCollections.reduce((prev, next) => {
    let target = prev
    if (next.name.toLowerCase().includes('color')) {
      target = prev.color ?? (prev.color = {})
    }
    Object.assign(target, next.result)
    return prev
  }, {} as any)

  const sanitized = JSON.parse(JSON.stringify(result, (key, value) => {
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

const getVariableValue = async (variable: VariableValue) => {
  if (typeof variable === 'object' && ('type' in variable) && variable.type === "VARIABLE_ALIAS") {
    const aliased = await figma.variables.getVariableById(variable.id)

    // TODO: Why do we always take the value for the first mode?
    const mode = Object.values(aliased.valuesByMode)[0]
    return getVariableValue(mode)
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
      const value: any = valuesByMode[mode.modeId];
      if (value !== undefined && ["COLOR", "FLOAT"].includes(resolvedType)) {
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
        obj.type = resolvedType === "COLOR" ? "color" : "number";
        if (value.type === "VARIABLE_ALIAS") {
          const resolvedValue = await getVariableValue(value)
          obj.value = resolvedType === "COLOR" ? rgbToHex(resolvedValue as any) : resolvedValue

          const ref = figma.variables.getVariableById(value.id)
          obj.aliases = `$${getVariableAlias(ref)}`
        } else {
          obj.value = resolvedType === "COLOR" ? rgbToHex(value) : value;
        }
      }
    }
  }

  return {
    name,
    result
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
