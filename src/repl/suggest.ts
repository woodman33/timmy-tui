/** "Did you mean" within edit distance 2 (playbook §16.5). */
export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export const nearest = (input: string, candidates: string[]): string | undefined =>
  candidates.map((c) => [c, distance(input, c)] as const).filter(([, d]) => d <= 2).sort((x, y) => x[1] - y[1])[0]?.[0];
