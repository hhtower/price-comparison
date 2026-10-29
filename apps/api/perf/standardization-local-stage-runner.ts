import {
  DATABASE_BENCHMARK_LOCAL_STAGES,
  runDatabaseBenchmarkLocalStageInCurrentProcess,
  type DatabaseBenchmarkLocalStage,
  type DatabaseBenchmarkScenarioName,
} from './standardization-database-benchmark.js';

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerArgument(name: string): number {
  const value = Number(requiredArgument(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function scenarioArgument(): DatabaseBenchmarkScenarioName {
  const value = requiredArgument('--scenario');
  if (!['balanced', 'high_duplication', 'low_duplication', 'retrieval_stress', 'publication_stress'].includes(value)) {
    throw new Error(`unknown benchmark scenario: ${value}`);
  }
  return value as DatabaseBenchmarkScenarioName;
}

function stageArgument(): DatabaseBenchmarkLocalStage {
  const value = requiredArgument('--stage');
  if (!DATABASE_BENCHMARK_LOCAL_STAGES.includes(value as DatabaseBenchmarkLocalStage)) {
    throw new Error(`unknown local benchmark stage: ${value}`);
  }
  return value as DatabaseBenchmarkLocalStage;
}

async function main(): Promise<void> {
  const raw = await runDatabaseBenchmarkLocalStageInCurrentProcess({
    size: positiveIntegerArgument('--size'),
    scenario: scenarioArgument(),
    seed: positiveIntegerArgument('--seed'),
    run: positiveIntegerArgument('--run'),
    stage: stageArgument(),
  });
  process.stdout.write(`${JSON.stringify(raw)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
