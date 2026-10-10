// Load before Reader/Foliate modules. Chrome 96 needs these at runtime even
// when Next has transpiled the application's syntax. core-js preserves clone
// cycles, typed arrays and ArrayBuffer transfers; JSON cloning cannot do that.
import 'core-js/actual/array/find-last-index';
import 'core-js/actual/structured-clone';
import { installAbortSignalCompat } from './abortSignalCompat';

installAbortSignalCompat();

// A groupBy polyfill for foliate-js
Object.groupBy ??= (iterable, callbackfn) => {
  const obj = Object.create(null);
  let i = 0;
  for (const value of iterable) {
    const key = callbackfn(value, i++);
    if (key in obj) {
      obj[key].push(value);
    } else {
      obj[key] = [value];
    }
  }
  return obj;
};

Map.groupBy ??= (iterable, callbackfn) => {
  const map = new Map();
  let i = 0;
  for (const value of iterable) {
    const key = callbackfn(value, i++),
      list = map.get(key);
    if (list) {
      list.push(value);
    } else {
      map.set(key, [value]);
    }
  }
  return map;
};
