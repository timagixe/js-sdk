const fs = require('fs');

const mb = (value) => Number((value / 1024 / 1024).toFixed(2));
const files = process.argv.slice(2);

if (files.length === 0) {
  console.error(
    'Usage: node repros/react-flag-memory-stress/summarize-results.js <result.json> [another-result.json ...]',
  );
  process.exit(1);
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`Missing result file: ${file}`);
    console.error('Run the stress repro for that label first, or pass only the JSON files that already exist.');
    process.exitCode = 1;
    continue;
  }

  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  const snapshots = Object.fromEntries(result.snapshots.map((snapshot) => [snapshot.label, snapshot]));
  const mount = snapshots['after-mount-after-gc'];
  const after = snapshots['after-rerenders-after-gc'];
  const unmount = snapshots['after-unmount-after-gc'];
  const peakHeap = Math.max(...result.snapshots.map((snapshot) => snapshot.heapUsed));
  const peakRss = Math.max(...result.snapshots.map((snapshot) => snapshot.rss));
  const gcTrend = result.snapshots
    .filter((snapshot) => /^after-rerender-\d+-after-gc$/.test(snapshot.label))
    .map((snapshot) => ({
      tick: Number(snapshot.label.match(/\d+/)[0]),
      heapUsedMB: mb(snapshot.heapUsed),
      rssMB: mb(snapshot.rss),
    }));

  console.log(
    JSON.stringify(
      {
        file,
        label: result.label,
        hookCount: result.hookCount,
        rerenders: result.rerenders,
        sampleEvery: result.sampleEvery,
        addCalls: result.addCalls,
        removeCalls: result.removeCalls,
        resolverCalls: result.resolverCalls,
        handlersAfterMount: mount.handlers,
        handlersAfterRerenders: after.handlers,
        handlersAfterUnmount: unmount.handlers,
        heapMountMB: mb(mount.heapUsed),
        heapAfterRerendersGcMB: mb(after.heapUsed),
        heapUnmountGcMB: mb(unmount.heapUsed),
        heapGrowthAfterGcFromMountMB: mb(after.heapUsed - mount.heapUsed),
        peakHeapMB: mb(peakHeap),
        rssMountMB: mb(mount.rss),
        rssAfterRerendersGcMB: mb(after.rss),
        rssUnmountGcMB: mb(unmount.rss),
        rssGrowthAfterGcFromMountMB: mb(after.rss - mount.rss),
        peakRssMB: mb(peakRss),
        gcTrend,
      },
      null,
      2,
    ),
  );
}
