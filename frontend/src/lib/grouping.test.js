import { describe, it, expect } from 'vitest';
import { parseGroupKeys, groupFilters, pathId, allPathIds, defaultOpenIds, treeStats, NONE } from './grouping';

const OPTIONS = [{ value: 'customer' }, { value: 'environment' }, { value: 'os' }, { value: 'health' }];

const TREE = [
  {
    dim: 'environment',
    value: 'prod',
    count: 3,
    children: [
      { dim: 'os', value: 'ubuntu', count: 2, children: null },
      { dim: 'os', value: NONE, count: 1, children: null },
    ],
  },
  { dim: 'environment', value: 'dev', count: 5, children: [{ dim: 'os', value: 'ubuntu', count: 5, children: null }] },
];

describe('grouping', () => {
  it('parses only offered keys, in order, at most three', () => {
    expect(parseGroupKeys('environment,nope,customer,environment', OPTIONS)).toEqual(['environment', 'customer']);
    expect(parseGroupKeys('customer,environment,os,health', OPTIONS)).toEqual(['customer', 'environment', 'os']);
    expect(parseGroupKeys('', OPTIONS)).toEqual([]);
  });

  it('a group filters by its own value and every ancestor, through the param map', () => {
    const path = [{ dim: 'environment', value: 'prod' }, { dim: 'os', value: NONE }];
    expect(groupFilters(path, { os: 'osType' })).toEqual({ environment: 'prod', osType: NONE });
    expect(pathId(path)).toBe(`environment=prod/os=${NONE}`);
  });

  it('opens headings always, leaves only when there are few', () => {
    expect([...defaultOpenIds(TREE)]).toHaveLength(5);
    const open = defaultOpenIds(TREE, { maxOpenLeaves: 2 });
    expect([...open]).toEqual(['environment=prod', 'environment=dev']);
    expect(allPathIds(TREE)).toHaveLength(5);
  });

  it('counts leaf groups and their rows', () => {
    expect(treeStats(TREE)).toEqual({ groups: 3, rows: 8 });
  });
});
