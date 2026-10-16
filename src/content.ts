import { MAX_BLOCKS, MAX_TEXT_LENGTH, MAX_BATCH_CHARS, MAX_TOTAL_BLOCKS, MAX_TOTAL_CHARS, type TextBlock, type Summary } from './shared';

type Managed = { id: string; element: HTMLElement; original: DocumentFragment; originalNodes: Node[]; source: string; summary: string; control: HTMLButtonElement; controlShape: string; expanded: boolean; snapshot: string };
const managed = new Map<string, Managed>();
const sourceNodes = new Map<string, HTMLElement>();
const observerById = new Map<string, MutationObserver>();
let documentObserver: MutationObserver | undefined;
let status: HTMLDivElement | undefined;
let statusTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let active = false;
let pendingRequestId: string | undefined;
let activeRunId: string | undefined;
let pendingSelection: HTMLElement | undefined;
const initialized = '__stretchtextInitialized';
const win = window as Window & { [initialized]?: boolean };

if (!win[initialized]) {
  win[initialized] = true;
  removeStatus();
  const controlStyles = document.createElement('style');
  controlStyles.textContent = 'button.stretchtext-summary:hover,button.stretchtext-summary:focus-visible,button.stretchtext-collapse:hover,button.stretchtext-collapse:focus-visible{text-decoration-line:underline!important;text-decoration-style:solid!important;text-decoration-color:color-mix(in srgb,currentColor 30%,transparent)!important;text-underline-offset:.2em}';
  document.documentElement.append(controlStyles);
  chrome.runtime.onMessage.addListener((message) => { if (message?.type === 'toggle') void toggle(); if (message?.type === 'stretch-selection') void stretchSelection(message.selectionText, message.unsupportedFrame); });
  window.addEventListener('pagehide', restoreAll);
}

async function stretchSelection(expectedText: unknown, unsupportedFrame = false): Promise<void> {
  if (active) { restoreAll(); showStatus('Restored the active Stretch run. Select text again to shorten a new passage.'); return; }
  removeStatus();
  if (unsupportedFrame || window !== window.top) { showStatus('Unsupported selection. Select prose in the main page, not a frame.'); return; }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) { showStatus('Select a passage in one prose block, then choose Stretch selection.'); return; }
  const range = selection.getRangeAt(0).cloneRange();
  const selectedText = range.toString();
  const text = selectedText.trim();
  const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const end = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
  const prose = 'p, li, blockquote, dd, dt, h1, h2, h3, h4, h5, h6';
  const block = start?.closest<HTMLElement>(prose);
  const inline = 'A,ABBR,B,BDI,BDO,BR,CITE,DEL,EM,I,INS,MARK,Q,S,SMALL,SPAN,STRONG,SUB,SUP,TIME,U,WBR'.split(',');
  if (typeof expectedText !== 'string' || expectedText !== selectedText || !block || end?.closest(prose) !== block || start?.closest('a, button, [role="link"], [role="button"]') || end?.closest('a, button, [role="link"], [role="button"]') || text.length > MAX_TEXT_LENGTH || !isSubstantive(text) || !isEligible(block) || Array.from(block.querySelectorAll<HTMLElement>('*')).some((element) => range.intersectsNode(element) && (!inline.includes(element.tagName) || !isVisible(element)))) {
    showStatus('Unsupported selection. Choose substantive text within one prose block; partial inline elements, controls, and cross-block selections are not supported.'); return;
  }
  const wrapper = document.createElement('span');
  wrapper.dataset.stretchSelection = 'true';
  try { range.surroundContents(wrapper); } catch { showStatus('That selection cannot be safely wrapped.'); return; }
  const ancestors: Node[] = [];
  for (let node: Node | null = wrapper.parentNode; node; node = node.parentNode) ancestors.push(node);
  const nodes = descendants(block);
  const originalShape = shape(block);
  const unchanged = () => {
    let node: Node | null = wrapper.parentNode;
    for (const ancestor of ancestors) { if (node !== ancestor) return false; node = node.parentNode; }
    const current = descendants(block);
    return wrapper.isConnected && current.length === nodes.length && current.every((child, index) => child === nodes[index]) && shape(block) === originalShape && isEligible(block) && isVisible(wrapper) && Array.from(wrapper.querySelectorAll<HTMLElement>('*')).every(isVisible);
  };
  const id = crypto.randomUUID();
  active = true;
  const run = ++generation;
  pendingSelection = wrapper;
  const runId = crypto.randomUUID(); activeRunId = runId;
  showStatus('Shortening selected text…', true);
  try {
    const ready = await chrome.runtime.sendMessage({ type: 'begin-run', runId }) as { error?: string };
    if (run !== generation || !active) { void chrome.runtime.sendMessage({ type: 'finish-run', runId }); return; }
    if (ready?.error) throw new Error(ready.error);
    if (!unchanged()) throw new Error('The selected text changed while Stretch was working; nothing was changed.');
    const requestId = crypto.randomUUID(); pendingRequestId = requestId;
    const result = await chrome.runtime.sendMessage({ type: 'summarize', requestId, runId, blocks: [{ id, text }] }) as { summaries?: Summary[]; error?: string };
    if (pendingRequestId === requestId) pendingRequestId = undefined;
    if (run !== generation || !active) return;
    if (result.error) throw new Error(result.error);
    if (!unchanged()) throw new Error('The selected text changed while Stretch was working; nothing was changed.');
    const summary = result.summaries?.find((item) => item.id === id)?.text;
    if (!summary || summary.length >= text.length) throw new Error('The selection could not be shortened.');
    compress(wrapper, id, text, summary);
    pendingSelection = undefined;
    active = true; activeRunId = undefined;
    void chrome.runtime.sendMessage({ type: 'finish-run', runId });
    showStatus('Selected text shortened. Click it to expand; use the toolbar to restore.');
  } catch (error) {
    if (run !== generation || !active) return;
    unwrapSelection(wrapper); pendingSelection = undefined;
    active = false; activeRunId = undefined;
    void chrome.runtime.sendMessage({ type: 'finish-run', runId });
    showStatus(error instanceof Error ? error.message : 'Could not shorten selection.');
  }
}

function descendants(node: Node): Node[] { return Array.from(node.childNodes).flatMap((child) => [child, ...descendants(child)]); }
function unwrapSelection(element: HTMLElement): void { if (element.parentNode) element.replaceWith(...Array.from(element.childNodes)); }

async function toggle(): Promise<void> {
  removeStatus();
  if (active) { restoreAll(); return; }
  active = true;
  const run = ++generation;
  const runId = crypto.randomUUID(); activeRunId = runId;
  try {
    const ready = await chrome.runtime.sendMessage({ type: 'begin-run', runId }) as { error?: string };
    if (run !== generation || !active) { void chrome.runtime.sendMessage({ type: 'finish-run', runId }); return; }
    if (ready?.error) throw new Error(ready.error);
  } catch (error) {
    if (run !== generation || !active) return;
    active = false; activeRunId = undefined;
    showStatus(error instanceof Error ? error.message : 'Could not load provider settings.');
    return;
  }
  showStatus('Finding eligible prose…', true);
  const candidates = findCandidates();
  const groups: TextBlock[][] = [];
  let batch: TextBlock[] = [], chars = 0, totalChars = 0, skipped = 0;
  for (const candidate of candidates) {
    const text = candidate.textContent?.trim() ?? '';
    if (!isSubstantive(text) || text.length > MAX_TEXT_LENGTH || groups.reduce((n, g) => n + g.length, 0) + batch.length >= MAX_TOTAL_BLOCKS || totalChars + text.length > MAX_TOTAL_CHARS) { skipped++; continue; }
    if (batch.length >= MAX_BLOCKS || chars + text.length > MAX_BATCH_CHARS) { if (batch.length) groups.push(batch); batch = []; chars = 0; }
    const id = crypto.randomUUID();
    batch.push({ id, text }); chars += text.length; totalChars += text.length; sourceNodes.set(id, candidate);
  }
  if (batch.length) groups.push(batch);
  if (!groups.length) { clearRun(); active = false; if (activeRunId) void chrome.runtime.sendMessage({ type: 'finish-run', runId: activeRunId }); activeRunId = undefined; showStatus('No eligible prose found.'); return; }
  let completed = 0;
  for (const group of groups) {
    if (run !== generation || !active) return;
    showStatus(`Shortening batch ${completed + 1} of ${groups.length}…`, true);
    try {
      const requestId = crypto.randomUUID(); pendingRequestId = requestId;
       const response = await chrome.runtime.sendMessage({ type: 'summarize', requestId, runId: activeRunId, blocks: group }) as { summaries?: Summary[]; error?: string };
      if (pendingRequestId === requestId) pendingRequestId = undefined;
      if (run !== generation || !active) return;
      if (response?.error) throw new Error(response.error);
      const summaries = new Map(response.summaries?.map((item) => [item.id, item.text]));
      for (const block of group) {
        const element = sourceNodes.get(block.id), summary = summaries.get(block.id);
        if (!element || !summary || !isEligible(element) || element.textContent?.trim() !== block.text || summary.length >= block.text.length) { sourceNodes.delete(block.id); continue; }
        compress(element, block.id, block.text, summary);
      }
      completed++;
    } catch (error) {
      if (run !== generation || !active) return;
      restoreAll(); showStatus(error instanceof Error ? error.message : 'Request failed.'); return;
    }
  }
  sourceNodes.clear();
  if (activeRunId) void chrome.runtime.sendMessage({ type: 'finish-run', runId: activeRunId });
  activeRunId = undefined;
  showStatus(`${managed.size} blocks shortened${skipped ? `; ${skipped} skipped` : ''}. Click a short form to expand; use the toolbar button to restore all.`);
  if (!managed.size) active = false;
}

function isSubstantive(text: string): boolean { return (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 40 && text.split(/\s+/).filter(Boolean).length >= 7; }

function findCandidates(): HTMLElement[] {
  const root = document.querySelector('main, article, [role="main"]') ?? document.body;
  return Array.from(root.querySelectorAll<HTMLElement>('p, li')).filter((element) => {
    if (element.tagName === 'P' && element.closest('li')) return false;
    if (element.tagName === 'LI' && element.querySelector(':scope > ul > li, :scope > ol > li')) return false;
    return isEligible(element);
  });
}

function isEligible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest('nav, header, footer, aside, button, form, input, textarea, select, [contenteditable], [role="button"], [role="link"], [role="checkbox"], [role="menu"], [role="tab"], pre, code, table, svg, [hidden], [aria-hidden="true"], details, summary, iframe, video, audio, canvas, img, picture, object, embed')) return false;
  if (element.querySelector('pre, code, table, svg, input, textarea, select, button, [contenteditable], [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], details, summary, iframe, video, audio, canvas, img, picture, object, embed, [hidden], [aria-hidden="true"]')) return false;
  return isVisible(element) && isSubstantive(element.textContent?.trim() ?? '');
}

function isVisible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
}

function shape(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return `#${node.textContent}`;
  if (!(node instanceof Element)) return `?${node.nodeName}`;
  return `<${node.tagName}:${Array.from(node.attributes).map((a) => `${a.name}=${a.value}`).sort().join(';')}>${Array.from(node.childNodes, shape).join('')}</${node.tagName}>`;
}

function snapshot(element: HTMLElement, control?: HTMLButtonElement): string {
  return Array.from(element.childNodes).filter((node) => node !== control).map(shape).join('');
}

function compress(element: HTMLElement, id: string, text: string, summary: string): void {
  const original = document.createDocumentFragment();
  while (element.firstChild) original.append(element.firstChild);
  const control = makeControl('stretchtext-summary', summary, false, (event) => { event.stopPropagation(); expand(id); });
  element.append(control);
  const item: Managed = { id, element, original, originalNodes: Array.from(original.childNodes), source: text, summary, control, controlShape: shape(control), expanded: false, snapshot: snapshotFromNodes(Array.from(original.childNodes)) };
  managed.set(id, item); watch(item);
}

function snapshotFromNodes(nodes: Node[]): string { return nodes.map(shape).join(''); }
function makeControl(className: string, text: string, expanded: boolean, click: (event: MouseEvent) => void): HTMLButtonElement {
  const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text;
  button.setAttribute('aria-expanded', String(expanded));
  button.style.cssText = 'display:inline;font:inherit;color:inherit;border:0;background:none;padding:0;text-align:inherit;cursor:pointer;text-decoration:none;';
  button.title = expanded ? 'Collapse to summary' : 'Show original text';
  button.addEventListener('click', click); return button;
}

function watch(item: Managed): void {
  if (!documentObserver) {
    documentObserver = new MutationObserver(() => {
      for (const [id, current] of managed) if (!current.element.isConnected) discardChanged(id, false);
    });
    documentObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  const observer = new MutationObserver(() => {
    const changed = item.expanded
      ? snapshot(item.element, item.control) !== `${item.snapshot}# ` || item.element.lastChild !== item.control || shape(item.control) !== item.controlShape
      : item.element.childNodes.length !== 1 || item.element.firstChild !== item.control || shape(item.control) !== item.controlShape;
    if (managed.get(item.id) === item && changed) discardChanged(item.id);
  });
  observer.observe(item.element, { childList: true, characterData: true, subtree: true, attributes: true }); observerById.set(item.id, observer);
}

function expand(id: string): void {
  const item = managed.get(id);
  if (!item || !collapsedUnchanged(item)) { discardChanged(id); return; }
  observerById.get(id)?.disconnect(); item.element.replaceChildren(item.original); item.expanded = true;
  item.control = makeControl('stretchtext-collapse', 'Collapse', true, (event) => { event.stopPropagation(); collapseBlock(id); });
  item.controlShape = shape(item.control);
  item.element.append(document.createTextNode(' '), item.control); watch(item);
}

function collapseBlock(id: string): void {
  const item = managed.get(id);
  if (!item || !expandedUnchanged(item)) { discardChanged(id); return; }
  observerById.get(id)?.disconnect();
  for (const node of item.originalNodes) item.original.append(node);
  item.element.replaceChildren(); item.control = makeControl('stretchtext-summary', item.summary, false, (event) => { event.stopPropagation(); expand(id); });
  item.controlShape = shape(item.control);
  item.element.append(item.control); item.expanded = false; watch(item);
}

function collapsedUnchanged(item: Managed): boolean { return item.control.isConnected && item.element.childNodes.length === 1 && item.element.firstChild === item.control && shape(item.control) === item.controlShape; }
function expandedUnchanged(item: Managed): boolean {
  return item.element.lastChild === item.control && item.control.isConnected && shape(item.control) === item.controlShape && snapshot(item.element, item.control) === `${item.snapshot}# `;
}

function discardChanged(id: string, restore = true): void {
  observerById.get(id)?.disconnect(); observerById.delete(id);
  const item = managed.get(id);
  if (item && restore) release(item);
  managed.delete(id); sourceNodes.delete(id);
  stopDocumentObserverIfIdle();
}

function release(item: Managed): void {
  const { element, control } = item;
  if (!element.isConnected) return;
  if (!item.expanded) {
    if (control.parentElement === element && shape(control) === item.controlShape) {
      for (const node of item.originalNodes) element.insertBefore(node, control);
      control.remove();
    } else if (control.parentElement === element && control.classList.contains('stretchtext-summary')) {
      control.replaceWith(...Array.from(control.childNodes));
    }
    if (element.dataset.stretchSelection === 'true') element.replaceWith(...Array.from(element.childNodes));
    return;
  }
  if (control.parentElement === element && shape(control) === item.controlShape) {
    const previous = control.previousSibling;
    control.remove();
    if (previous?.nodeType === Node.TEXT_NODE && previous.textContent === ' ') previous.remove();
  }
  if (element.dataset.stretchSelection === 'true') element.replaceWith(...Array.from(element.childNodes));
}

function stopDocumentObserverIfIdle(): void {
  if (!managed.size) { documentObserver?.disconnect(); documentObserver = undefined; }
}

function clearRun(): void { sourceNodes.clear(); for (const observer of observerById.values()) observer.disconnect(); observerById.clear(); }
function restoreAll(): void {
  active = false; generation++;
  if (pendingSelection) { unwrapSelection(pendingSelection); pendingSelection = undefined; }
  if (activeRunId) { void chrome.runtime.sendMessage({ type: 'finish-run', runId: activeRunId }); activeRunId = undefined; }
  if (pendingRequestId) { void chrome.runtime.sendMessage({ type: 'cancel', requestId: pendingRequestId }); pendingRequestId = undefined; }
  for (const [id, item] of managed) {
    observerById.get(id)?.disconnect();
    release(item);
    managed.delete(id);
  }
  clearRun(); documentObserver?.disconnect(); documentObserver = undefined; removeStatus();
}

function showStatus(message: string, processing = false): void {
  clearTimeout(statusTimer);
  statusTimer = undefined;
  removeOrphanedStatuses(status);
  if (!status?.isConnected) { status = document.createElement('div'); status.dataset.stretchtext = 'status'; status.setAttribute('role', 'status'); status.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:320px;padding:8px 12px;background:#222;color:white;font:13px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 2px 8px #0005;'; document.documentElement.append(status); }
  status.textContent = message;
  if (!processing) statusTimer = setTimeout(removeStatus, 5000);
}
function removeOrphanedStatuses(keep?: HTMLElement): void {
  for (const notice of Array.from(document.querySelectorAll('[data-stretchtext="status"]'))) {
    if (notice !== keep) notice.remove();
  }
}
function removeStatus(): void { clearTimeout(statusTimer); statusTimer = undefined; removeOrphanedStatuses(); status = undefined; }
