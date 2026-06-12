import { Prisma, type PrismaClient } from "@addroid/db";
import {
  formatQueryCatalogValidationError,
  isQueryCatalogValidationError,
  runPerformanceCompare,
  runPerformanceQuery,
  type PerformanceCompareResult,
  type PerformanceCompareInput,
  type PerformanceQueryInput,
  type PerformanceQueryResult,
  type PerformanceQueryStore,
  type PerformanceSnapshotQueryRow,
} from "@addroid/queue";

export interface QueryCatalogToolResult {
  message: string;
  result: PerformanceQueryResult | PerformanceCompareResult;
}

export function createPrismaPerformanceQueryStore(prisma: PrismaClient): PerformanceQueryStore {
  return {
    async listPerformanceSnapshots(input): Promise<PerformanceSnapshotQueryRow[]> {
      const account = input.level === "account"
        ? await prisma.adAccount.findUnique({
            where: { id: input.accountId },
            select: { displayName: true, key: true },
          })
        : null;
      const where: Prisma.PerformanceSnapshotWhereInput = {
        accountId: input.accountId,
        nodeType: input.level,
        metricDate: {
          gte: new Date(`${input.since}T00:00:00.000Z`),
          lte: new Date(`${input.until}T00:00:00.000Z`),
        },
      };
      if (input.level !== "account" && input.statusFilter !== "all") {
        where.hierarchy = { is: { status: input.statusFilter } };
      }
      const rows = await prisma.performanceSnapshot.findMany({
        where,
        select: {
          nodeKey: true,
          metricDate: true,
          impressions: true,
          clicks: true,
          conversions: true,
          spendMicros: true,
          frequency: true,
          hierarchy: {
            select: {
              displayName: true,
              status: true,
            },
          },
        },
        orderBy: [{ nodeKey: "asc" }, { metricDate: "asc" }],
      });
      return rows.map((row) => ({
        nodeKey: row.nodeKey,
        displayName: row.hierarchy?.displayName ?? account?.displayName ?? account?.key ?? row.nodeKey,
        status: row.hierarchy?.status ?? (input.level === "account" ? "active" : null),
        metricDate: row.metricDate.toISOString().slice(0, 10),
        spendMicros: row.spendMicros,
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
        frequency: decimalToNumber(row.frequency),
      }));
    },
  };
}

export async function runPerformanceQueryCatalogTool(input: {
  prisma: PrismaClient;
  args: Record<string, unknown>;
}): Promise<QueryCatalogToolResult> {
  try {
    const result = await runPerformanceQuery({
      store: createPrismaPerformanceQueryStore(input.prisma),
      input: input.args as PerformanceQueryInput,
    });
    return {
      message: formatPerformanceQueryMessage(result),
      result,
    };
  } catch (err) {
    if (isQueryCatalogValidationError(err)) {
      throw new Error(`query_performance validation failed: ${formatQueryCatalogValidationError(err)}`);
    }
    throw err;
  }
}

export async function runPerformanceCompareCatalogTool(input: {
  prisma: PrismaClient;
  args: Record<string, unknown>;
}): Promise<QueryCatalogToolResult> {
  try {
    const result = await runPerformanceCompare({
      store: createPrismaPerformanceQueryStore(input.prisma),
      input: input.args as PerformanceCompareInput,
    });
    return {
      message: formatPerformanceCompareMessage(result),
      result,
    };
  } catch (err) {
    if (isQueryCatalogValidationError(err)) {
      throw new Error(`compare_performance validation failed: ${formatQueryCatalogValidationError(err)}`);
    }
    throw err;
  }
}

export function formatPerformanceQueryMessage(result: PerformanceQueryResult): string {
  return `${result.window.label} の ${result.level} ${result.metric} を ${result.rank} 順で ${result.rows.length}件集計しました。`;
}

export function formatPerformanceCompareMessage(result: PerformanceCompareResult): string {
  return `${result.currentWindow.label} と ${result.baselineWindow.label} の ${result.level} ${result.metric} 変化を ${result.rows.length}件集計しました。`;
}

function decimalToNumber(
  value: Prisma.Decimal | number | string | null | undefined
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = value.toNumber();
  return Number.isFinite(parsed) ? parsed : null;
}
