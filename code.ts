console.clear();

function sanitizeName(name: string) {
  return name.toLowerCase() // Names should be lower case
    .replace('%', '') // Don't export % in the names
    .replace(/[^a-zA-Z0-9-.]/g, '-') // Any special characters should be replaced with a -
}

function exportToJSON() {
  const collections = figma.variables.getLocalVariableCollections();
  const result = collections.map(processCollection).reduce((prev, next) => ({ ...prev, ...next }), {})
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
function processCollection({ name, modes, variableIds }) {
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
  return result;
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
