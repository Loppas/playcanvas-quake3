/** C's `toupper` in the C locale: ASCII letters only. */
function upper(c: string): string {
  return c >= 'a' && c <= 'z' ? String.fromCharCode(c.charCodeAt(0) - 32) : c;
}

/**
 * `Com_StringContains` (`common.c:590–612`), without regard to case: where `run` first starts in
 * `name` from `from` on, or -1.
 */
function contains(name: string, from: number, run: string): number {
  const last = Math.max(0, name.length - from) - run.length;
  for (let i = 0; i <= last; i++) {
    let j = 0;
    while (j < run.length && upper(name[from + i + j]) === upper(run[j])) j++;
    if (j === run.length) return from + i;
  }
  return -1;
}

/**
 * `Com_Filter` (`common.c:619–692`) without regard to case, as `cvarlist` and `cmdlist` call it:
 * whether `name` matches `filter`. `*` stands for any run of characters, `?` for any one, and
 * `[a-z]` for one of a set; `[[` is a `[`. A filter that runs out has matched, so `cl` matches
 * every name that starts with it.
 *
 * Where Quake 3 reads on past either string's end, this reads as if a run of zeros followed it.
 */
export function comFilter(filter: string, name: string): boolean {
  const f = (i: number) => filter[i] ?? '\0';
  const n = (i: number) => name[i] ?? '\0';
  let fi = 0;
  let ni = 0;
  while (f(fi) !== '\0') {
    if (f(fi) === '*') {
      fi++;
      let run = '';
      while (f(fi) !== '\0' && f(fi) !== '*' && f(fi) !== '?' && f(fi) !== '[') run += filter[fi++];
      if (run !== '') {
        const at = contains(name, ni, run);
        if (at < 0) return false;
        ni = at + run.length;
      }
    } else if (f(fi) === '?') {
      fi++;
      ni++;
    } else if (f(fi) === '[' && f(fi + 1) === '[') {
      fi++;
    } else if (f(fi) === '[') {
      fi++;
      let found = false;
      while (f(fi) !== '\0' && !found) {
        if (f(fi) === ']' && f(fi + 1) !== ']') break;
        if (f(fi + 1) === '-' && f(fi + 2) !== '\0' && (f(fi + 2) !== ']' || f(fi + 3) === ']')) {
          const c = upper(n(ni));
          if (c >= upper(f(fi)) && c <= upper(f(fi + 2))) found = true;
          fi += 3;
        } else {
          if (upper(f(fi)) === upper(n(ni))) found = true;
          fi++;
        }
      }
      if (!found) return false;
      while (f(fi) !== '\0' && !(f(fi) === ']' && f(fi + 1) !== ']')) fi++;
      fi++;
      ni++;
    } else {
      if (upper(f(fi)) !== upper(n(ni))) return false;
      fi++;
      ni++;
    }
  }
  return true;
}
