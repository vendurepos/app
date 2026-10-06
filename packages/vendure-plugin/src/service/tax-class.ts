import { RequestContext, TaxCategory, TransactionalConnection } from '@vendure/core';

// ADR 0005 ruling (c): default when absent, otherwise match the trimmed name before the id.
export async function resolveTaxCategory(
  ctx: RequestContext, connection: TransactionalConnection, taxClass: string | undefined,
): Promise<TaxCategory | null> {
  const repository = connection.getRepository(ctx, TaxCategory);
  if (taxClass === undefined) return repository.findOne({ where: { isDefault: true } });
  const categories = await repository.find();
  return categories.find(category => category.name.trim().toLowerCase() === taxClass.trim().toLowerCase())
    ?? categories.find(category => String(category.id) === taxClass) ?? null;
}
