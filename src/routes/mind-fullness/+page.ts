// 呼吸アニメは JS 必須なので CSR を常に有効にする
export const csr = true;

// since there's no dynamic data here, we can prerender
// it so that it gets served as a static asset in production
export const prerender = true;
