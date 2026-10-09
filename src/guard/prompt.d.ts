// The guard prompt, bundled as text by esbuild's `--loader:.md=text`.
declare module "*.md" {
  const text: string;
  export default text;
}
