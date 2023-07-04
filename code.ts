console.clear();

function sanitizeName(name: string) {
  return name.toLowerCase() // Names should be lower case
    .replace('%', '') // Don't export % in the names
    .replace(/[^a-zA-Z0-9-.]/g, '-') // Any special characters should be replaced with a -
}

function exportToJSON() {
  const collections = figma.variables.getLocalVariableCollections();

  // We go to a bit of effort to get our tokens into a format that styled-tokens
  // will understand. All color sets belong under a top level 'color' heading.
  // There is no easy way to determine if a set is for colors, so we check to
  // see if the set name contains the word 'color'. High tech, I know :D
  const result = collections.map(processCollection).reduce((prev, next) => {
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

// Indicates whether variable references should be preserved, or if the value
// of the variable should be used instead.
const PRESERVE_REFERENCES = false
function processCollection({ name, modes, variableIds }: VariableCollection) {
  const result = {}
  const onlyOneMode = modes.length === 1

  modes.forEach((mode) => {
    const target: any = onlyOneMode ? result : (result[mode.name] = {})
    variableIds.forEach((variableId) => {
      const { name, resolvedType, valuesByMode } =
        figma.variables.getVariableById(variableId);
      const value: any = valuesByMode[mode.modeId];
      if (value !== undefined && ["COLOR", "FLOAT"].includes(resolvedType)) {
        let obj: any = target;
        name.split("/").forEach((groupName) => {
          obj[groupName] = obj[groupName] || {};
          obj = obj[groupName];
        });
        obj.type = resolvedType === "COLOR" ? "color" : "number";
        if (value.type === "VARIABLE_ALIAS") {
          const ref = figma.variables.getVariableById(value.id)
          if (!PRESERVE_REFERENCES) {
            const modes = ref.valuesByMode;
            const aliasedValue = Object.values(modes)[0]
            obj.value = resolvedType === "COLOR" ? rgbToHex(aliasedValue as any) : aliasedValue
          } else {
            obj.value = `{${ref.name.replace(/\//g, ".")}}`
          }
        } else {
          obj.value = resolvedType === "COLOR" ? rgbToHex(value) : value;
        }
      }
    });
  });

  return {
    name,
    result
  }
}

figma.ui.onmessage = (e) => {
  if (e.type === "EXPORT") {
    exportToJSON();
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
