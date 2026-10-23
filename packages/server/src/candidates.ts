import type { FeatureKind, PageStructure } from '@uievidence/shared';

export interface Candidate {
  name: string;
  description: string;
  kind: FeatureKind;
}

const INTERACTION_NAMES = { tab: 'Tab 切换', pagination: '分页', modal: '弹窗展开' } as const;

/**
 * 从页面结构生成功能条目候选。
 * 规则只描述"页面上看到了什么":
 *   - 能直接看到的归为"已观察事实";
 *   - 看到入口但没有执行的(提交、删除、支付等),只能归为"推测功能",不会写成已验证。
 * 候选不会自动入库,由使用者在界面上勾选后创建。
 */
export function candidatesFromStructure(s: PageStructure): Candidate[] {
  const out: Candidate[] = [];

  if (s.nav.length >= 2) {
    out.push({
      name: '站点导航',
      description: `导航入口:${s.nav
        .slice(0, 12)
        .map((n) => n.text)
        .join('、')}`,
      kind: 'observed',
    });
  }

  for (const form of s.forms) {
    const fields = form.fields.map((f) => `${f.label || f.name || f.type}${f.required ? '(必填)' : ''}`).join('、');
    out.push({
      name: `表单:${form.submitText || '未命名表单'}`,
      description: `字段:${fields || '无'}。提交方式 ${form.method.toUpperCase()}。提交入口已记录,未执行提交,提交后的处理逻辑待确认。`,
      kind: 'observed',
    });
  }

  for (const list of s.lists) {
    const label = { list: '内容列表', table: '数据表格', cards: '卡片列表' }[list.kind];
    out.push({
      name: label,
      description: `共 ${list.itemCount} 项,示例:${list.sample.filter(Boolean).slice(0, 3).join(' / ')}`,
      kind: 'observed',
    });
  }

  const byType = new Map<string, number>();
  for (const i of s.interactions) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
  for (const [type, count] of byType) {
    out.push({
      name: INTERACTION_NAMES[type as keyof typeof INTERACTION_NAMES],
      description: `页面上有 ${count} 个${INTERACTION_NAMES[type as keyof typeof INTERACTION_NAMES]}入口。`,
      kind: 'observed',
    });
  }

  if (s.dialogs.length) {
    out.push({ name: '弹窗', description: `页面包含弹窗:${s.dialogs.slice(0, 5).join('、')}`, kind: 'observed' });
  }

  const seen = new Set<string>();
  for (const b of s.blocked) {
    if (seen.has(b.text)) continue;
    seen.add(b.text);
    out.push({
      name: `可能存在:${b.text}`,
      description: `页面上有「${b.text}」入口,出于只读原则没有执行,背后的功能和数据影响需要进一步确认。`,
      kind: 'inferred',
    });
  }

  return out;
}
