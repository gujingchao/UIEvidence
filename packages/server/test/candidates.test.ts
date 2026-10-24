import { describe, expect, it } from 'vitest';
import type { PageStructure } from '@uievidence/shared';
import { groupDuplicates } from '@uievidence/shared';
import { candidatesFromStructure } from '../src/candidates.js';

const empty: PageStructure = {
  title: '',
  lang: '',
  headings: [],
  nav: [],
  links: [],
  forms: [],
  lists: [],
  dialogs: [],
  interactions: [],
  blocked: [],
};

describe('candidatesFromStructure', () => {
  it('把同一页面上重复出现的相同表单合并成一条并带数量', () => {
    const form = { action: '', method: 'get', fields: [], submitText: 'Add to basket' };
    const out = candidatesFromStructure({ ...empty, forms: Array.from({ length: 20 }, () => ({ ...form })) });
    const forms = out.filter((c) => c.name === '表单:Add to basket');
    expect(forms).toHaveLength(1);
    expect(forms[0]?.description).toContain('共有 20 处');
  });

  it('字段不同的表单不会被合并', () => {
    const base = { action: '', method: 'post', submitText: '发送' };
    const out = candidatesFromStructure({
      ...empty,
      forms: [
        { ...base, fields: [{ name: 'a', type: 'text', label: '姓名', required: true, placeholder: '' }] },
        { ...base, fields: [{ name: 'b', type: 'text', label: '电话', required: false, placeholder: '' }] },
      ],
    });
    expect(out.filter((c) => c.name === '表单:发送')).toHaveLength(2);
  });
});

describe('groupDuplicates', () => {
  it('保持首次出现的顺序并计数', () => {
    expect(groupDuplicates(['a', 'b', 'a', 'c', 'a'], (x) => x)).toEqual([
      { item: 'a', count: 3 },
      { item: 'b', count: 1 },
      { item: 'c', count: 1 },
    ]);
  });
});
