const shimUrl = "data:text/javascript,export const env = {}; export const tracing = undefined;";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: shimUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
