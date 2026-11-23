// Reviewed fingerprints from unmodified DSH 0.2.2-rc.1, rc.2 and rc.3.
// These are private host methods. Unknown implementations still refuse writes.
// rc.2/rc.3 add batch append; the single-event snapshot and publication guards
// remain equivalent. commit, publicationEntry and persistence methods match rc.1.
export const HOST_FINGERPRINTS = {
  "session": {
    "append": [
      "f434d8e94303e06be3f3ecddb599f90c7bff421eeb4ca3920611f68925565751",
      "f90d8979863a27976e0e03bda3254ce5f3a07bc830edeae81e0d60c22127bdaf"
    ],
    "commit": "8eee8bb4669ebd6e095704c40965cb44b93e599d0138be06f776b15a57fe5051",
    "publicationEntry": "5911ed4cef7de7b69d5fb57da657215a00a9528e3a144961df57fac7eab15bd6"
  },
  "surface": {
    "validateNext": "e8a6063e0309af191f2c8e3cb6a8e3032a467849491854781dc0150e28eac6eb",
    "_processDelta": "e9aeb7cc40961a937f2d919f84acb58a63d24c62eb49db943b14866e71eb75a7"
  },
  "backend": {
    "open": "4a9b09f882a15c402bc07809aadd56a5c56338d146065d8bc9ba6fa58816d450",
    "encodeEventBatch": "fc3cff5eaac5f2e1ac81e08034983a1f803faca7a5ceaeee76cd8348d403e16a",
    "readStoredLog": "64dad5470fc318fa215e55b15a32216826daf9cd3927aab8f46c7da87a995861",
    "decodeStoredLog": "47e9e101e6c07d263c68ae79d86e85a6f45756c95be81ea8a5f48905830ece34",
    "acquireLease": "4a06d1ec0b52691f6a8831bc57645c01323360edd12789ad0f4c2d252e3a48b8",
    "findLog": "4ad82fe5e5bcab8960793b5da04e489f048e83d26a24c25307163b297e6113ad",
    "persistBatch": "227e0f3b840751bb672f401bdfe8600bac4593f63b05e6822a99b965c9830ef7"
  },
  "handle": {
    "run": "acfab5319099452d174470d07ea94a5e14aba287f07eddceec72d18878cf52f9",
    "enqueueLive": "bd14662c1f08e3bfe210e1415d8d18fdbd256d4fdc1287b3f2f5f505906ee4b1",
    "persistContiguous": "283f4de9c0aa8c0df8c0425081408ad689be4dd520e39257d8b7a504db83f7f4",
    "read": "53bc47892a55dbde60afb652093c5f21974f1150cbe5ee762e830e84b0974877",
    "close": "beb89d9c30645186f394525558c0b745d0818ba1cca073aa316efe0dd95fbeb7"
  }
};

const REGEX_PREFIX_WORDS = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete',
  'in', 'instanceof', 'new', 'yield', 'await', 'else', 'of',
]);
const REGEX_PREFIX_CHARS = new Set([
  '', '(', '[', '{', ',', ';', ':', '?', '=', '!', '&', '|', '^', '~', '+', '-', '*', '%', '<', '>',
]);
const ASI_KEYWORDS = new Set(['return', 'throw', 'break', 'continue', 'yield']);
const isLineTerminator = (ch) => ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';

/**
 * Token-aware normalizer for host method sources: strips comments and insignificant
 * whitespace between syntax tokens while preserving string/template/regex literal
 * interiors and ASI-sensitive newlines.
 */
export function normalizeHostMethodSource(src) {
  const text = String(src ?? '');
  const tokens = [];
  const templateBraceDepths = [];
  let i = 0;
  let lastSig = '';

  const canStartRegex = () => REGEX_PREFIX_CHARS.has(lastSig) || REGEX_PREFIX_WORDS.has(lastSig);

  const scanTemplateChunk = (startQuote) => {
    let lit = startQuote;
    while (i < text.length) {
      const ch = text[i];
      lit += ch;
      if (ch === '\\' && i + 1 < text.length) {
        lit += text[++i];
      } else if (ch === '$' && text[i + 1] === '{') {
        lit += '{';
        i += 2;
        tokens.push({ type: 'lit', value: lit });
        templateBraceDepths.push(0);
        lastSig = '{';
        return;
      } else if (ch === '`') {
        i += 1;
        tokens.push({ type: 'lit', value: lit });
        lastSig = '`';
        return;
      }
      i += 1;
    }
    tokens.push({ type: 'lit', value: lit });
    lastSig = '`';
  };

  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];

    if (/\s/.test(c)) {
      let newline = false;
      while (i < text.length && /\s/.test(text[i])) {
        if (isLineTerminator(text[i])) newline = true;
        i += 1;
      }
      tokens.push({ type: 'ws', newline });
      continue;
    }

    if (c === '/' && n === '/') {
      i += 2;
      while (i < text.length && !isLineTerminator(text[i])) i += 1;
      tokens.push({ type: 'ws', newline: true });
      continue;
    }

    if (c === '/' && n === '*') {
      let newline = false;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (isLineTerminator(text[i])) newline = true;
        i += 1;
      }
      i += 2;
      tokens.push({ type: 'ws', newline });
      continue;
    }

    if (c === '"' || c === "'") {
      const q = c;
      let lit = c;
      i += 1;
      while (i < text.length) {
        const ch = text[i];
        lit += ch;
        if (ch === '\\' && i + 1 < text.length) {
          lit += text[++i];
        } else if (ch === q) {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ type: 'lit', value: lit });
      lastSig = q;
      continue;
    }

    if (c === '`') {
      i += 1;
      scanTemplateChunk('`');
      continue;
    }

    if (c === '/' && n !== '/' && n !== '*' && canStartRegex()) {
      let rx = c;
      i += 1;
      let inClass = false;
      while (i < text.length) {
        const ch = text[i];
        rx += ch;
        if (ch === '\\' && i + 1 < text.length) {
          rx += text[++i];
        } else if (ch === '[') {
          inClass = true;
        } else if (ch === ']') {
          inClass = false;
        } else if (ch === '/' && !inClass) {
          i += 1;
          while (i < text.length && /[a-z]/i.test(text[i])) rx += text[i++];
          break;
        }
        i += 1;
      }
      tokens.push({ type: 'lit', value: rx });
      lastSig = '/';
      continue;
    }

    if (/[A-Za-z0-9_$]/.test(c)) {
      let word = '';
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) word += text[i++];
      tokens.push({ type: 'word', value: word });
      lastSig = word;
      continue;
    }

    if (c === '{' && templateBraceDepths.length > 0) {
      templateBraceDepths[templateBraceDepths.length - 1] += 1;
    } else if (c === '}' && templateBraceDepths.length > 0) {
      if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
        templateBraceDepths.pop();
        i += 1;
        scanTemplateChunk('}');
        continue;
      }
      templateBraceDepths[templateBraceDepths.length - 1] -= 1;
    }

    tokens.push({ type: 'punct', value: c });
    lastSig = c;
    i += 1;
  }

  const isWordChar = (ch) => Boolean(ch && /[A-Za-z0-9_$]/.test(ch));
  let out = '';
  let prevTok = null;
  let sawWs = null;

  for (const tok of tokens) {
    if (tok.type === 'ws') {
      sawWs = { newline: Boolean(sawWs?.newline || tok.newline) };
      continue;
    }
    if (sawWs && prevTok) {
      if (sawWs.newline && prevTok.type === 'word' && ASI_KEYWORDS.has(prevTok.value)) {
        out += '\n';
      } else {
        const prevEnd = prevTok.value.at(-1);
        const nextStart = tok.value[0];
        const needSpace =
          (isWordChar(prevEnd) && isWordChar(nextStart)) ||
          (prevEnd === '+' && nextStart === '+') ||
          (prevEnd === '-' && nextStart === '-') ||
          (prevEnd === '/' && (nextStart === '/' || nextStart === '*'));
        if (needSpace) out += ' ';
      }
    }
    out += tok.value;
    prevTok = tok;
    sawWs = null;
  }
  return out;
}

export const HOST_NORMALIZED_FINGERPRINTS = {
  "session": {
    "append": [
      "0a5d34ede29f33476d94e3e08b2344f8a5c8d419d409eb760dfa65b9d4787aa3",
      "713afc30226dc9bb4c871b9907927d773f467fa64f990cf167e27bca79c00a21"
    ],
    "commit": "de2ebf59a9336c6e75c12f2522cfb7f9a2c83ae76fcd643a331966cd17b6c916",
    "publicationEntry": "fcb945bba56f8a130576be4f327569d5ffc5f8f2a130a8f0163335aa34ec8409"
  },
  "surface": {
    "validateNext": "72786bbcd1e645643c3e50c0ef37eb9f7effc8b03738839db1ea9cbc6c1db41b",
    "_processDelta": "626d2425742ae9963591144c3673c7f87c573d694edc62c7173bf5a76f3c3e7d"
  },
  "backend": {
    "open": "7e60b89db746a6afd206d96b3bc5e745ef0994b6e2eec3a61bd9b5f3ca00482e",
    "encodeEventBatch": "bdb7f9c2314c0545cdcc41bdc25f683d2e59de74b7d9a51c1768bccbf9b6eb2e",
    "readStoredLog": "4f0087fcb311a1cfb0eae366b32401496dce810f3b57526cf83c80303eecf4ce",
    "decodeStoredLog": "3c11e76f7eeb44053f1dc795e79d0dd45f4ba09031bbb2eb611f01e51c0c0711",
    "acquireLease": "2c7b76d6f3c2453670b07cb7f905cb01d9312a6ffe8c3cab7e68e476bba22d6f",
    "findLog": "f54a30fe4c33724f9bca4da01152c68f16d68e70bc7e3e72553c62e288809593",
    "persistBatch": "895b3078c92da08d8a733c1519e0b6cdcd2604c8a37227c89cf27abfae335f0a"
  },
  "handle": {
    "run": "f16aa1f5e75487404551d0560280737626eb2fc3b4426526b804c03455ee1fba",
    "enqueueLive": "4dd0bc4d71c595351c74588b3849f32118c366eda326ced88c285d9e9e4dee7e",
    "persistContiguous": "14d1f5bb4bfab04555180b2f46e85155660c644d56df8e777c36ef7b175abe29",
    "read": "9d5389a3531db3658af3272ebcb0730793245b337fe33385062a40635e6d4518",
    "close": "d9fad510536d300ae26a50348b7967732533847546c0161300f4b2f04df4f4e2"
  }
};
