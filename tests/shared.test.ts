import { describe, expect, it } from 'vitest';
import { isLocalDate, localDate, recordInputSchema } from '@yearbook/shared';

describe('本地民用日期与记录输入', () => {
  it('在本地午夜和闰日保留发生日期，不经过 UTC 截日', () => {
    expect(localDate(new Date(2024, 1, 29, 0, 5))).toBe('2024-02-29');
    expect(localDate(new Date(2025, 11, 31, 23, 55))).toBe('2025-12-31');
    for (const date of ['0001-01-01', '2000-02-29', '2024-02-29', '2026-09-12']) expect(isLocalDate(date), date).toBe(true);
    for (const date of ['0000-01-01', '1900-02-29', '2025-02-29', '2024-04-31', '2024-13-01', '2024-00-01', '2024-01-00', '2024-2-1', '2024-01-01T00:00:00Z']) expect(isLocalDate(date), date).toBe(false);
  });

  it('允许只写一句话、稍后补日期，拒绝空白、无效日期及未声明字段', () => {
    expect(recordInputSchema.parse({ body: '吃到了今年第一口桂花糕。' })).toMatchObject({ occurredOn: null, people: [], tags: [], includeInYearbook: true });
    expect(recordInputSchema.safeParse({ body: '   ' }).success).toBe(false);
    expect(recordInputSchema.safeParse({ body: '补记', occurredOn: '2025-02-29' }).success).toBe(false);
    expect(recordInputSchema.safeParse({ body: '补记', deletedAt: '2026-01-01' }).success).toBe(false);
  });
});
