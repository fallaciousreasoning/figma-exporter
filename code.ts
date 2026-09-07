// These group names will be mapped in the generated variables file. null group
// names will be skipped. For example, this means Themable/Dark/Pink/10 will be
// exported as color.dark.pink[10] in the JSON and
// Semantic/Dialogs-and-modals/Divider will be color.dialog.divider
const MAP_GROUP_NAMES = {
  'Dialogs-and-modals': 'Dialogs',
  'Semantic': null,
  'Themable': null
}

function postStatus(message: string) {
  console.log(`[export] ${message}`)
  figma.ui.postMessage({ type: 'EXPORT_STATUS', message })
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
  const warnings: string[] = []

  // We only export what this file owns. Variables from subscribed team
  // libraries belong to their own file and should be exported from there.
  postStatus('Reading collections in this file...')
  const collections = await figma.variables.getLocalVariableCollectionsAsync()

  if (!collections.length) {
    warnings.push('This file has no variable collections of its own. Variables from subscribed libraries need to be exported from the file that defines them.')
  }

  const totalVariables = collections.reduce((sum, c) => sum + c.variableIds.length, 0)
  postStatus(`Processing ${totalVariables} variables across ${collections.length} collections...`)

  // We go to a bit of effort to get our tokens into a format that styled-tokens
  // will understand. All color sets belong under a top level 'color' heading.
  // There is no easy way to determine if a set is for colors, so we check to
  // see if the set name contains the word 'color'. High tech, I know :D
  // Similarly, easing and duration/timing collections get their own top-level keys.
  const processedCollections = await Promise.all(collections.map(c => processCollection(c, warnings)))
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

  postStatus(`Done - exported ${totalVariables} variables.`)
  figma.ui.postMessage({ type: "EXPORT_RESULT", result: sanitized, warnings });
}

const getVariableValue = async (variable: VariableValue, modeId: string, seen: Set<string> = new Set()) => {
  if (typeof variable === 'object' && ('type' in variable) && variable.type === "VARIABLE_ALIAS") {
    // A variable that aliases back into its own chain would recurse forever.
    if (seen.has(variable.id)) {
      throw new Error(`Circular variable alias involving ${variable.id}`)
    }
    seen.add(variable.id)

    const aliased = await figma.variables.getVariableByIdAsync(variable.id)
    if (!aliased) {
      throw new Error(`Alias points at a variable that no longer exists (${variable.id})`)
    }

    // If we have a mode in the alias which matches the mode of our variable, use that. Otherwise just take the first mode.
    const mode = aliased.valuesByMode[modeId] ?? Object.values(aliased.valuesByMode)[0]
    return getVariableValue(mode, modeId, seen)
  }

  if (isColorExpression(variable)) {
    return resolveColorExpression(variable, modeId, seen)
  }

  return variable
}

// Referencing a variable at a reduced opacity is stored as an expression rather
// than an alias, and @figma/plugin-typings doesn't describe it yet.
interface ColorExpression {
  type: 'VARIABLE_EXPRESSION'
  expressionFunction: string
  expressionArguments: any[]
}

const isColorExpression = (value: any): value is ColorExpression =>
  typeof value === 'object'
  && value !== null
  && value.type === 'VARIABLE_EXPRESSION'

// Figma writes "reference X at 50%" as COMPOSE_COLOR(X, 50). That alpha is held
// nowhere else - not on X, and not on the variable itself - so composing it here
// is the only way to get a concrete colour out of the expression.
async function resolveColorExpression({ expressionFunction, expressionArguments }: ColorExpression, modeId: string, seen: Set<string>) {
  if (expressionFunction !== 'COMPOSE_COLOR') {
    throw new Error(`Unsupported colour expression ${expressionFunction}`)
  }

  // Each argument is its own branch of the alias graph, so give each a private
  // copy of `seen` - one shared set would read a re-used variable as circular.
  const [colorArgument, opacityArgument] = expressionArguments
  const color: any = await getVariableValue(colorArgument, modeId, new Set(seen))
  const opacity: any = await getVariableValue(opacityArgument, modeId, new Set(seen))

  if (typeof color !== 'object' || color === null) {
    throw new Error(`${expressionFunction} expected a colour, got ${JSON.stringify(color)}`)
  }
  if (typeof opacity !== 'number') {
    throw new Error(`${expressionFunction} expected a numeric opacity, got ${JSON.stringify(opacity)}`)
  }

  // The opacity is a percentage, and it multiplies whatever alpha the referenced
  // colour already carries rather than replacing it.
  const alpha = (typeof color.a === 'number' ? color.a : 1) * (opacity / 100)
  return { r: color.r, g: color.g, b: color.b, a: alpha }
}

// A composed colour flattened to rgba() stops following the theme, because the
// channels it baked in came from whichever mode we happened to resolve. Keeping
// the referenced colour and the opacity apart lets a consumer rebuild the colour
// per theme, the same way it does for a plain reference.
async function describeColorComposition(value: any, modeId: string): Promise<{ variable: Variable, opacity: number, expressionFunction: string } | null> {
  if (!isColorExpression(value) || value.expressionFunction !== 'COMPOSE_COLOR') return null

  const [colorArgument, opacityArgument] = value.expressionArguments
  const opacity: any = await getVariableValue(opacityArgument, modeId)
  // An opacity we can't read as a number can't be handed to a consumer, so let
  // the flat rgba() stand alone rather than exporting half a recipe.
  if (typeof opacity !== 'number') return null

  // Composing an already-composed colour nests the expressions, and Figma
  // multiplies the opacities down the chain rather than replacing them.
  const nested = await describeColorComposition(colorArgument, modeId)
  if (nested) {
    return {
      variable: nested.variable,
      opacity: nested.opacity * (opacity / 100),
      expressionFunction: value.expressionFunction
    }
  }

  // Anything other than a reference - a literal colour, say - has nothing for a
  // consumer to point at.
  if (typeof colorArgument !== 'object' || colorArgument === null || colorArgument.type !== 'VARIABLE_ALIAS') return null

  const variable = await figma.variables.getVariableByIdAsync(colorArgument.id)
  if (!variable) {
    throw new Error(`Composed colour points at a variable that no longer exists (${colorArgument.id})`)
  }

  return { variable, opacity: opacity / 100, expressionFunction: value.expressionFunction }
}

async function processCollection({ name: collectionName, modes, variableIds }: VariableCollection, warnings: string[]) {
  const result = {}
  const onlyOneMode = modes.length === 1

  const variables = await Promise.all(variableIds.map(async (variableId) => {
    try {
      return await figma.variables.getVariableByIdAsync(variableId)
    } catch (err: any) {
      warnings.push(`${collectionName}: could not load variable ${variableId} - ${err?.message ?? err}`)
      return null
    }
  }))

  for (const mode of modes) {
    const target: any = onlyOneMode ? result : (result[mode.name] = {})
    for (const variable of variables) {
      if (!variable) continue

      const { name, resolvedType, valuesByMode } = variable;
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

        // One malformed variable shouldn't take down the whole export, and the
        // warning needs to name it so it can actually be found in Figma.
        try {
          // Resolve before formatting whether or not this looks like an alias -
          // the formatters only understand concrete values.
          const resolvedValue = await getVariableValue(value, mode.modeId)
          obj.value = formatVariableValue(rt, resolvedValue)

          // "Reference X at 50%" is an expression rather than an alias, so export
          // the colour and the opacity separately and let the consumer compose
          // them - the rgba() above only holds for the mode we resolved.
          const composition = await describeColorComposition(value, mode.modeId)
          if (composition) {
            // Name the expression Figma used so a consumer knows which recipe
            // rebuilds the token rather than having to infer it from the fields.
            obj.function = composition.expressionFunction
            obj.referencedVariable = `$${getVariableAlias(composition.variable)}`
            // Trailing float noise from multiplying opacities isn't meaningful.
            obj.opacity = parseFloat(composition.opacity.toFixed(4))
          } else if (value.type === "VARIABLE_ALIAS" && !isTranslucent(rt, resolvedValue)) {
            // Figma can't put an opacity on an alias, so a translucent token's
            // alpha always lives on the color at the end of the chain. Pointing
            // at the referenced variable would drop that alpha, so for these the
            // inlined rgba() has to stand on its own.
            const ref = await figma.variables.getVariableByIdAsync(value.id)
            obj.referencedVariable = `$${getVariableAlias(ref)}`
          }
        } catch (err: any) {
          warnings.push(`${collectionName} \u203a ${name} (${rt}, mode "${mode.name}"): ${err?.message ?? err}`)
        }
      }
    }
  }

  const maybeWrapped = collectionName.toLowerCase().includes('typography')
    ? {
      typography: result
    }
    : result

  return {
    name: collectionName,
    result: maybeWrapped
  }
}

figma.ui.onmessage = async (e) => {
  if (e.type !== "EXPORT") return

  try {
    await exportToJSON()
  } catch (err: any) {
    // Without this the promise rejects silently and the UI spins forever.
    console.error('[export] failed', err)
    // Figma's stack traces omit the message line, so send both.
    const detail = [err?.message, err?.stack].filter(Boolean).join('\n')
    figma.ui.postMessage({
      type: "EXPORT_ERROR",
      message: detail || String(err)
    })
  }
};

figma.showUI(__html__, {
  width: 500,
  height: 500,
  themeColors: true
})

// Variable colors come through as RGBA, but plain RGB (no alpha) shows up too.
function rgbToHex(color) {
  const { r, g, b, a = 1 } = color
  if ([r, g, b, a].some(n => typeof n !== 'number')) {
    // Report the value we were handed, not the destructured channels - those
    // are all `undefined` for any unexpected shape and name nothing.
    throw new Error(`Expected an RGB(A) color, got ${JSON.stringify(color)}`)
  }

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

// A translucent color can only be exported as a literal rgba(), never as a
// reference to another variable.
function isTranslucent(resolvedType: string, value: any) {
  return resolvedType === "COLOR"
    && typeof value === 'object'
    && value !== null
    && typeof value.a === 'number'
    && value.a !== 1
}

function formatVariableValue(resolvedType: string, value: any) {
  if (resolvedType === "COLOR") {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`Expected a color object, got ${JSON.stringify(value)}`)
    }
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
