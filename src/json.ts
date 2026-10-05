// Strict JSON parser for the config file. Unlike JSON.parse it rejects
// duplicate keys (a silent "last one wins" would hide typos) and builds
// prototype-less objects. Errors include line and column.

export function parseJsonStrict(text: string): unknown {
  let i = 0;
  const src = text.replace(/^﻿/, '');
  const fail = (msg: string): never => {
    const before = src.slice(0, i);
    const line = before.split('\n').length;
    const col = i - before.lastIndexOf('\n');
    throw new SyntaxError(`${msg} at line ${line}, column ${col}`);
  };
  const ws = () => { while (i < src.length && ' \t\n\r'.includes(src[i]!)) i++; };
  const value = (depth: number): unknown => {
    if (depth > 64) fail('nesting too deep');
    ws();
    const c = src[i];
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = Object.create(null);
      ws();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (src[i] !== '"') fail('expected a "quoted" key');
        const key = string();
        if (Object.prototype.hasOwnProperty.call(obj, key)) fail(`duplicate key "${key.slice(0, 80)}"`);
        ws();
        if (src[i++] !== ':') fail('expected ":"');
        obj[key] = value(depth + 1);
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (src[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') return string();
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (!m) fail(c === undefined ? 'unexpected end of input' : `unexpected character "${c}"`);
    i += m![0].length;
    return m![0] === 'true' ? true : m![0] === 'false' ? false : m![0] === 'null' ? null : Number(m![0]);
  };
  const string = (): string => {
    const start = i;
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') i++;
      else if (src.charCodeAt(i) < 0x20) fail('control character in string');
      i++;
    }
    if (i >= src.length) fail('unterminated string');
    i++;
    return JSON.parse(src.slice(start, i)) as string;
  };
  const result = value(0);
  ws();
  if (i < src.length) fail('unexpected content after the end of the JSON value');
  return result;
}
