export function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
export function isFailure(error) {
  return ['signIn', 'setup', 'unavailable', 'unsupported'].includes(error?.code);
}
export function requireVideoID(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    throw failure('unavailable', 'This item has no playable YouTube video ID.');
  }
  return id;
}
