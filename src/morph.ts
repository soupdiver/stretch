type Word = { text: string; key: string; rect: DOMRect; css: string };
type Frame = { words: Word[]; rect: DOMRect; height: string; resize: boolean };
const running = new Map<HTMLElement, () => void>();
const duration = 400;
const easing = 'cubic-bezier(.22,.61,.36,1)';
const typography = ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-kerning', 'font-feature-settings', 'font-variation-settings', 'letter-spacing', 'word-spacing', 'text-transform', 'text-decoration', 'color'] as const;

export function cancelMorph(element: HTMLElement): void { running.get(element)?.(); }

function simpleGeometry(style: CSSStyleDeclaration): boolean {
  return style.writingMode === 'horizontal-tb' && style.direction === 'ltr' && style.transform === 'none' && style.translate === 'none' && style.rotate === 'none' && style.scale === 'none' && style.filter === 'none' && style.perspective === 'none' && style.columnCount === 'auto' && Number(style.opacity) === 1 && style.visibility === 'visible' && style.zoom === '1';
}

function measure(element: HTMLElement): Frame | undefined {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth || (element.textContent?.length ?? 0) > 12000) return;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!simpleGeometry(style)) return;
    if (node !== document.body && node !== document.documentElement && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) return;
  }
  const children = element.querySelectorAll<HTMLElement>('*');
  if (children.length > 240) return;
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  for (const child of [element, ...children]) {
    const style = getComputedStyle(child);
    if (!simpleGeometry(style) || style.textShadow !== 'none' || style.overflowX !== 'visible' || style.overflowY !== 'visible') return;
    for (const pseudo of ['::before', '::after']) {
      if (!['none', 'normal'].includes(getComputedStyle(child, pseudo).content)) return;
    }
    styles.set(child, style);
  }
  const words: Word[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let nodes = 0;
  while ((node = walker.nextNode())) {
    if (++nodes > 240) return;
    const parent = node.parentElement;
    if (!parent) return;
    const style = styles.get(parent)!;
    const css = typography.map((property) => `${property}:${style.getPropertyValue(property)};`).join('');
    for (const match of (node.textContent ?? '').matchAll(/\S+/gu)) {
      if (words.length >= 180) return;
      const range = document.createRange();
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const rects = range.getClientRects();
      if (rects.length !== 1 || !rects[0].width || !rects[0].height) return;
      words.push({ text: match[0], key: match[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLocaleLowerCase(), rect: rects[0], css });
    }
  }
  const style = getComputedStyle(element);
  const parentStyle = element.parentElement && getComputedStyle(element.parentElement);
  return words.length ? { words, rect, height: style.height, resize: ['block', 'list-item'].includes(style.display) && !!parentStyle && ['block', 'flow-root'].includes(parentStyle.display) && style.position === 'static' && style.float === 'none' && style.minHeight === '0px' && style.maxHeight === 'none' } : undefined;
}

function anchors(before: Word[], after: Word[]): [number, number][] {
  const rows = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) rows[i][j] = before[i].key && before[i].key === after[j].key ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const result: [number, number][] = [];
  for (let i = 0, j = 0; i < before.length && j < after.length;) {
    if (before[i].key && before[i].key === after[j].key) { result.push([i++, j++]); }
    else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
    else j++;
  }
  return result;
}

/** Measure real text without wrapping it; the swapped DOM remains the accessible source of truth. */
export function morph(element: HTMLElement, swap: () => void): void {
  cancelMorph(element);
  let before: Frame | undefined;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  try { if (!motion.matches && !running.size && typeof element.animate === 'function') before = measure(element); } catch { /* Unsupported geometry uses the normal DOM swap. */ }
  swap();
  if (!before) return;
  let host: HTMLElement | undefined;
  const animations: Animation[] = [];
  const listeners = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    clearTimeout(timer); cancelAnimationFrame(frame); listeners.abort();
    for (const animation of animations) animation.cancel();
    host?.remove(); running.delete(element);
  };
  try {
    const after = measure(element);
    if (!after || Math.abs(before.rect.left - after.rect.left) > 1 || Math.abs(before.rect.top - after.rect.top) > 1 || (before.resize && Math.abs(before.rect.width - after.rect.width) > 1)) return;
    const pairs = anchors(before.words, after.words);
    if (!pairs.length) return;
    host = document.createElement('stretchtext-morph');
    host.dataset.stretchtext = 'morph'; host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;pointer-events:none!important;z-index:2147483646!important;overflow:hidden!important;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const isolation = document.createElement('style');
    isolation.textContent = ':host::before,:host::after{content:none!important;display:none!important}';
    shadow.append(isolation);
    const animate = (target: HTMLElement, frames: Keyframe[], options: KeyframeAnimationOptions = {}) => {
      const animation = target.animate(frames, { duration, easing, fill: 'both', ...options });
      animations.push(animation);
      // Cancellation rejects finished; consume it even when construction fails halfway through.
      void animation.finished.catch(() => {});
      return animation;
    };
    const draw = (word: Word, from: DOMRect, to: DOMRect, entering?: boolean, delay = 0) => {
      const span = document.createElement('span'); span.textContent = word.text;
      span.style.cssText = `all:initial;position:absolute;white-space:pre;line-height:1;pointer-events:none;${word.css}left:${word.rect.left}px;top:${word.rect.top}px;`;
      span.style.lineHeight = `${word.rect.height}px`;
      shadow.append(span);
      const start = `translate(${from.left - word.rect.left}px,${from.top - word.rect.top}px)`;
      const end = `translate(${to.left - word.rect.left}px,${to.top - word.rect.top}px)`;
      const frames: Keyframe[] = entering === undefined
        ? [{ transform: start, opacity: 1 }, { transform: end, opacity: 1 }]
        : [
          { transform: start, opacity: entering ? 0 : 1, offset: 0 },
          { opacity: 0, offset: entering ? .2 : .3 },
          { opacity: entering ? 1 : 0, offset: .6 },
          { transform: end, opacity: entering ? 1 : 0, offset: 1 }
        ];
      animate(span, frames, { delay, duration: duration - delay });
    };
    for (const [i, j] of pairs) {
      const from = before.words[i], to = after.words[j];
      if (from.text === to.text) draw(to, from.rect, to.rect);
      else { draw(from, from.rect, to.rect, false); draw(to, from.rect, to.rect, true); }
    }
    const unmatched = (words: Word[], side: 0 | 1, entering: boolean) => {
      const matched = new Set(pairs.map((pair) => pair[side]));
      words.forEach((word, index) => {
        if (matched.has(index)) return;
        const nearest = pairs.reduce((best, pair) => Math.abs(pair[side] - index) < Math.abs(best[side] - index) ? pair : best);
        const from = before!.words[nearest[0]].rect, to = after.words[nearest[1]].rect;
        const shifted = new DOMRect(word.rect.left + (entering ? from.left - to.left : to.left - from.left), word.rect.top + (entering ? from.top - to.top : to.top - from.top), word.rect.width, word.rect.height);
        const delay = Math.min(100, Math.abs(nearest[side] - index) * 14);
        draw(word, entering ? shifted : word.rect, entering ? word.rect : shifted, entering, delay);
      });
    };
    unmatched(before.words, 0, false); unmatched(after.words, 1, true);
    document.documentElement.append(host);
    // Hide real glyphs without changing node attributes, backgrounds, or opacity.
    const parents = new Set<HTMLElement>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) if (node.parentElement) parents.add(node.parentElement);
    for (const parent of parents) {
      animate(parent, [{ color: 'transparent', textDecorationColor: 'transparent' }, { color: 'transparent', textDecorationColor: 'transparent' }]);
      const style = getComputedStyle(parent);
      if (style.color !== 'rgba(0, 0, 0, 0)' || style.getPropertyValue('-webkit-text-fill-color') !== 'rgba(0, 0, 0, 0)') { cleanup(); return; }
    }
    if (before.resize && after.resize && before.height !== after.height) animate(element, [{ height: before.height }, { height: after.height }]);
    running.set(element, cleanup);
    for (const event of ['scroll', 'resize', 'pagehide', 'pointerdown', 'keydown']) window.addEventListener(event, cleanup, { capture: true, passive: true, signal: listeners.signal });
    motion.addEventListener('change', cleanup, { signal: listeners.signal });
    const checkPosition = () => {
      const rect = element.getBoundingClientRect();
      if (!element.isConnected || !host?.isConnected || Math.abs(rect.left - after.rect.left) > 1 || Math.abs(rect.top - after.rect.top) > 1 || Math.abs(rect.width - after.rect.width) > 1) { cleanup(); return; }
      frame = requestAnimationFrame(checkPosition);
    };
    frame = requestAnimationFrame(checkPosition);
    timer = setTimeout(cleanup, duration + 100);
    void Promise.all(animations.map((animation) => animation.finished)).then(cleanup, cleanup);
  } catch { cleanup(); }
}
