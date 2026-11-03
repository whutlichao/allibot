export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {};', shortCircuit: true };
  }
  return next(specifier, context);
}
