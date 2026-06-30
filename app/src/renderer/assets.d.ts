declare module '*.css';

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '/icon.png' {
  const src: string;
  export default src;
}
