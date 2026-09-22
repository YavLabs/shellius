import { buildGroupTree, parseGroupBy, countGroups, NONE } from '../groupTree.js';

describe('parseGroupBy', () => {
  it('keeps offered keys, in order, without repeats, at most three', () => {
    expect(parseGroupBy('customer,bogus,environment,customer', ['customer', 'environment'])).toEqual(['customer', 'environment']);
    expect(parseGroupBy('a,b,c,d', ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c']);
    expect(parseGroupBy(undefined, ['a'])).toEqual([]);
  });
});

describe('buildGroupTree', () => {
  const rows = [
    { values: { env: 'prod', os: 'ubuntu' } },
    { values: { env: 'prod', os: null } },
    { values: { env: 'dev', os: 'ubuntu' }, count: 5 },
    { values: { env: 'prod', os: 'ubuntu' } },
  ];

  it('nests, counts (weighted), and puts None last', () => {
    const tree = buildGroupTree(rows, [
      { key: 'env', order: ['prod', 'staging', 'dev'] },
      { key: 'os', label: (v) => (v === NONE ? 'No OS' : v) },
    ]);
    expect(tree.map((n) => [n.value, n.count])).toEqual([['prod', 3], ['dev', 5]]);
    expect(tree[0].children.map((n) => [n.label, n.count])).toEqual([['ubuntu', 2], ['No OS', 1]]);
    expect(tree[0].children[1].value).toBe(NONE);
    expect(tree[1].children[0].children).toBeNull();
    expect(countGroups(tree)).toBe(5);
  });

  it('without a fixed order, the biggest group comes first', () => {
    const tree = buildGroupTree(rows, [{ key: 'env' }]);
    expect(tree.map((n) => n.value)).toEqual(['dev', 'prod']);
  });

  it('no levels, no tree', () => {
    expect(buildGroupTree(rows, [])).toEqual([]);
  });
});
