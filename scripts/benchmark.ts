import { normalize } from '../src/sources/apple-health.ts';
import { canonical, sha256 } from '../src/json.ts';
import { workout } from '../tests/helpers.ts';
const input = {workouts:Array.from({length:100},(_,i)=>workout({
  identifier:`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`,
  source_name:'S'.repeat(900),device_name:'D'.repeat(900),
  start_date:`Oct ${i%28+1}, 2026 at ${String(Math.floor(i/28)+8).padStart(2,'0')}:00`,
  end_date:`Oct ${i%28+1}, 2026 at ${String(Math.floor(i/28)+9).padStart(2,'0')}:00`,
}))};
const bytes=Buffer.byteLength(JSON.stringify(input));
const timings:number[]=[];
for(let i=0;i<21;i++) {
  const start=process.cpuUsage();
  const r=normalize(input,'America/Los_Angeles');
  await sha256(canonical(r));
  const cpu=process.cpuUsage(start);timings.push((cpu.user+cpu.system)/1000);
}
console.log(JSON.stringify({workouts:100,body_bytes:bytes,cold_node_cpu_ms:timings[0],
  warm_node_cpu_median_ms:timings.slice(1).sort((a,b)=>a-b)[10],
  note:'Node CPU is a local reference, not Cloudflare billed CPU. Validate deployed Worker CPU at the configured maximum before production.'},null,2));
