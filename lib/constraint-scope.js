import {auditCompaction} from './audit.js';

// Requirements outside the replacement span stay visible in their original
// messages. They need no duplicate quote in the new checkpoint, but generated
// notes must still respect their polarity, values, conditions and object scope.
export function auditMemorySelection({selection,...options}) {
  const local=new Set(selection.active.map(message=>message.seq));
  const userMessages=[...selection.active,...selection.retained??[]].sort((a,b)=>a.seq-b.seq);
  const report=auditCompaction({...options,userMessages});
  return {...report,lost:report.lost.filter(item=>item.reason!=='coverage'||local.has(item.seq))};
}
