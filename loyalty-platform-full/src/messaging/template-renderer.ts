/**
 * Renders Module 6's Handlebars-achtige templates: {{variable}} substitution
 * and simple {{#if field operator value}}...{{/if}} conditional blocks.
 * Deliberately minimal — this is a content block toggle, not a programming
 * language, per the design doc's explicit reasoning (section 4).
 */
export function renderTemplate(body: string, variables: Record<string, unknown>): string {
  let result = body;

  // Conditional blocks: {{#if field > value}}...{{/if}}
  const ifBlockRegex = /\{\{#if\s+(\w+)\s*(>|<|>=|<=|==|!=)?\s*([^}]*)\}\}([\s\S]*?)\{\{\/if\}\}/g;
  result = result.replace(ifBlockRegex, (_match, field, operator, rawValue, content) => {
    const fieldValue = variables[field];
    let shouldShow: boolean;

    if (!operator) {
      shouldShow = !!fieldValue;
    } else {
      const compareValue = isNaN(Number(rawValue)) ? rawValue.trim().replace(/['"]/g, '') : Number(rawValue.trim());
      const numericField = typeof fieldValue === 'number' ? fieldValue : Number(fieldValue);
      switch (operator) {
        case '>':
          shouldShow = numericField > (compareValue as number);
          break;
        case '<':
          shouldShow = numericField < (compareValue as number);
          break;
        case '>=':
          shouldShow = numericField >= (compareValue as number);
          break;
        case '<=':
          shouldShow = numericField <= (compareValue as number);
          break;
        case '==':
          shouldShow = fieldValue === compareValue;
          break;
        case '!=':
          shouldShow = fieldValue !== compareValue;
          break;
        default:
          shouldShow = false;
      }
    }
    return shouldShow ? content : '';
  });

  // Variable substitution: {{variable}}
  result = result.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = variables[key];
    return value !== undefined && value !== null ? String(value) : '';
  });

  return result.trim();
}
