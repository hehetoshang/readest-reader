/** Native parsers take filesystem paths, never URLs delegated to RemoteFile. */
export const isNativeBookPath = (path: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:/i.test(path) || /^[a-z]:[\\/]/i.test(path);
