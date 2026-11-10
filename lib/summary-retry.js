import {setTimeout as delay} from 'node:timers/promises';
export const DEFAULT_SUMMARY_RETRY_COUNT=2;
export const DEFAULT_SUMMARY_RETRY_DELAY_MS=1000;
export function summaryRetryPolicy(options={}) {
  return {count:Number.isInteger(options.retryCount)&&options.retryCount>=0&&options.retryCount<=4?options.retryCount:DEFAULT_SUMMARY_RETRY_COUNT,
    delayMs:Number.isInteger(options.retryDelayMs)&&options.retryDelayMs>=0&&options.retryDelayMs<=30000?options.retryDelayMs:DEFAULT_SUMMARY_RETRY_DELAY_MS};
}
export const CONTENT_RETRY_CODES=new Set(['PROGRESS_FACT_CONFLICT','SUMMARY_STRUCTURE_INVALID','SUMMARY_INVALID','SUMMARY_NOT_SMALLER','RETIRED_MEMORY_REINTRODUCED','EMPTY_SUMMARY','CHECKPOINT_COVERAGE_INCOMPLETE','CONSTRAINT_LOST','CONSTRAINT_POLARITY_LOST','CONTINUATION_STRUCTURE','CONTINUATION_TOOL_OUTPUT','CONTINUATION_TOO_LARGE','MAX_TOKENS']);
export function retryableSummaryError(error){
  const chain=[],seen=new Set();
  for(let e=error,n=0;e&&n<5&&!seen.has(e);e=e.cause,n++){seen.add(e);chain.push(e);}
  if(chain.some(e=>[400,401,403,404,405,413,422].includes(e.status??e.statusCode??e.response?.status)))return false;
  if(CONTENT_RETRY_CODES.has(error?.code)||error?.code==='SUMMARY_TIMEOUT')return true;
  for(const e of chain){
    const status=e.status??e.statusCode??e.response?.status;
    if([408,425,429,500,502,503,504].includes(status))return true;
    if(['TIMEOUT','TRANSPORT','ECONNRESET','ETIMEDOUT','ECONNABORTED','EPIPE','EAI_AGAIN','ECONNREFUSED','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','NETWORK_ERROR','NETWORK','STREAM_INTERRUPTED','STREAM_ERROR','ABORTED'].includes(e.code))return true;
    if(e.name==='AbortError'||e.name==='APIConnectionTimeoutError')return true;
    if(/fetch failed|\b(?:request|connection|connect|read|headers|body) (?:timed out|timeout)\b|network (?:error|failure)|socket hang up|connection (?:error|reset|closed)|premature (?:close|end)|stream (?:interrupted|disconnected)|\b(?:HTTP[ /:]*)?(?:429|502|503|504)\b/i.test(e.message??''))return true;
  }
  return false;
}
export async function waitForSummaryRetry(base,index,signal){
  signal?.throwIfAborted?.();const ms=Math.min(30000,base*2**Math.max(0,index-1));
  if(ms>0)try{await delay(ms,undefined,{signal});}catch(error){if(signal?.aborted)throw signal.reason??error;throw error;}
  signal?.throwIfAborted?.();return ms;
}
