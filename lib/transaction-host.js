// Compatibility fingerprints from unmodified DSH 0.2.2-rc.1. Not a public host API.
// surface/backend/handle are unchanged from 0.2.1-rc.5; only Session's three
// publication methods changed (append/publicationEntry gained the announcement
// guard, commit was refactored with identical behavior for published sessions).
export const HOST_FINGERPRINTS = {
  "session": {
    "append": "f434d8e94303e06be3f3ecddb599f90c7bff421eeb4ca3920611f68925565751",
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
