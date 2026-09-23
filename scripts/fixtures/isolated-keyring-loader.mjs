// Integration tests must never read or overwrite the user's OS credential store.
export function resolve(specifier, context, nextResolve) {
  if (specifier === "@napi-rs/keyring") {
    return {
      url: 'data:text/javascript,export class AsyncEntry { constructor() { throw new Error("isolated test keyring"); } }',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
