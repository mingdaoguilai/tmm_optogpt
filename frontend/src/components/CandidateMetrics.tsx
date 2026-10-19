import type {Candidate} from '../types';
import {formatPercent} from '../utils';

const percent=(n:number|null|undefined)=>n==null?'未记录（请复算）':formatPercent(n);
export function CandidateMetrics({current,initial}:{current:Candidate;initial:Candidate|null}) {
  const metrics:[string,keyof Candidate][]=[['平均违反误差','requirement_score'],['考核 MAE（容差前）','weighted_mae'],
    ['最大考核偏差（容差前）','max_deviation'],['最大超差（容差后）','max_violation'],['加权达标比例','pass_rate']];
  return <div className="workflow-table-scroll"><table className="workflow-table"><thead><tr><th>同网格指标</th>{initial&&<th>精修初值</th>}<th>当前结果</th></tr></thead><tbody>{metrics.map(([label,key])=><tr key={key}><th>{label}</th>{initial&&<td>{percent(initial[key] as number|undefined)}</td>}<td>{percent(current[key] as number|undefined)}</td></tr>)}</tbody></table></div>;
}

export function BandMetrics({current,initial}:{current:Candidate;initial:Candidate|null}) {
  return <div className="workflow-table-scroll"><table className="workflow-table"><thead><tr><th>波段 / 要求</th><th>版本</th><th>MAE</th><th>最大偏差</th><th>最大超差</th><th>达标比例</th></tr></thead><tbody>{(current.band_metrics??[]).flatMap((band,i)=>{
    const before=initial?.band_metrics?.find(b=>b.channel===band.channel&&b.start_nm===band.start_nm&&b.end_nm===band.end_nm&&b.kind===band.kind);
    const rows=before?[{band:before,name:'初值'},{band,name:'当前'}]:[{band,name:'当前'}];
    return rows.map(({band:b,name})=><tr key={`${i}-${name}`}><td>{b.channel} {b.start_nm}–{b.end_nm} nm · {b.kind}</td><td>{name}</td><td>{percent(b.mae)}</td><td>{percent(b.max_deviation)}</td><td>{percent(b.max_violation)}</td><td>{percent(b.pass_rate)}</td></tr>);
  })}</tbody></table>{!current.band_metrics?.length&&<p className="search-help">此结果无局部波段统计；全波段指标见上表。旧记录可先复算补齐。</p>}</div>;
}
