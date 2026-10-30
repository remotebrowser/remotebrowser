// Turns the page's accessibility tree into short text for the LLM, so it can
// write code for the page that is open now. The page can hold a prompt
// injection, so this is only data, and the code is checked as usual.

// Enough for the main parts of a page, while the prompt stays small and fast.
const MAX_PAGE_LENGTH = 12_000;
const MAX_TEXT_LENGTH = 200;
// A real page is never this deep; it stops a broken or hostile tree.
const MAX_DEPTH = 50;

// These only wrap other nodes, or repeat text that a parent already has.
const HIDDEN_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'LabelText', 'ListMarker', 'MenuListPopup']);

// Like cleanInstruction(), so page text cannot fake a tag or a new line.
const cleanText = (value) => {
  const text = String(value ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/<\/?(request|page)[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}...` : text;
};

const property = (node, name) => node.properties?.find((item) => item.name === name)?.value?.value;

const describeNode = (node, role, name) => {
  let line = name ? `- ${role} "${name}"` : `- ${role}`;
  const value = cleanText(node.value?.value);
  if (value && value !== name) line += ` = "${value}"`;
  const level = property(node, 'level');
  if (role === 'heading' && level) line += ` [level=${level}]`;
  for (const state of ['checked', 'selected', 'expanded', 'disabled']) {
    const on = property(node, state);
    if (on === true || on === 'true') line += ` [${state}]`;
  }
  const url = role === 'link' ? cleanText(property(node, 'url')) : '';
  if (url) line += ` [url=${url}]`;
  return line;
};

/**
 * @param {{url?: string, title?: string, nodes?: any[]}} page from Accessibility.getFullAXTree
 * @returns {string}
 */
const describePage = ({ url = '', title = '', nodes = [] }) => {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines = [`URL: ${cleanText(url)}`, `Title: ${cleanText(title)}`];
  let length = lines.join('\n').length;
  let cut = false;
  const seen = new Set();

  // parentTexts: the name and value of the nearest shown parent.
  const visit = (node, depth, parentTexts) => {
    if (cut || !node || seen.has(node.nodeId) || depth > MAX_DEPTH) return;
    seen.add(node.nodeId);
    const role = node.role?.value ?? '';
    const name = cleanText(node.name?.value);
    // Static text that only repeats its parent, such as a link label, adds nothing.
    const shown =
      !node.ignored &&
      !HIDDEN_ROLES.has(role) &&
      role !== 'RootWebArea' &&
      !(role === 'StaticText' && (!name || parentTexts.includes(name)));
    let childDepth = depth;
    let childParentTexts = parentTexts;
    if (shown) {
      const line = `${'  '.repeat(depth)}${describeNode(node, role === 'StaticText' ? 'text' : role, name)}`;
      if (length + line.length + 1 > MAX_PAGE_LENGTH) {
        cut = true;
        lines.push('(The rest of the page is cut.)');
        return;
      }
      lines.push(line);
      length += line.length + 1;
      childDepth = depth + 1;
      childParentTexts = [name, cleanText(node.value?.value)];
    }
    for (const childId of node.childIds ?? []) visit(byId.get(childId), childDepth, childParentTexts);
  };

  const root = nodes.find((node) => !node.parentId);
  visit(root, 0, []);
  if (lines.length === 2) lines.push('(The page is empty.)');
  return lines.join('\n');
};

export { describePage, MAX_PAGE_LENGTH };
