import {useEffect,useRef,useState} from 'react';
import type {AdoptedCandidate,CandidateVerification,SimulationRequest} from '../types';
import {api} from '../api';
import {fingerprint,verificationRequest,spectrumCsv} from '../workflow';
import {downloadText,formatPercent} from '../utils';

interface Props {
  adoption:AdoptedCandidate; request:SimulationRequest; verification:CandidateVerification|null;
  onVerification:(value:CandidateVerification)=>void; onCompare:()=>void;
}
export function AdoptionVerification({adoption,request,verification,onVerification,onCompare}:Props) {
  const payload=verificationRequest(adoption,request);
  const key=fingerprint(payload);
  const activeKey=useRef(key); activeKey.current=key;
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const isCurrent=verification && fingerprint({simulation:verification.simulation,target:verification.target,
    requirements:verification.requirements,evaluation_wavelengths_nm:verification.evaluation_wavelengths_nm})===key;
  const unchanged=fingerprint(request)===fingerprint(adoption.conditions);
  const run=async()=>{
    setBusy(true);setError('');
    try {const result=await api.verifyCandidate(payload); if(mounted.current&&activeKey.current===key) onVerification(result);}
    catch(e){if(mounted.current&&activeKey.current===key) setError(e instanceof Error?e.message:String(e));}
    finally {if(mounted.current)setBusy(false);}
  };
  return <section className="panel workflow-card" aria-label="采用候选复核">
    <div className="panel-heading"><h2>已采用 #{adoption.candidate.rank} · {adoption.variant==='initial'?'精修初值':'当前候选'}</h2><button className="small-button" onClick={onCompare}>返回候选比较</button></div>
    <p className="search-help">使用保存的目标/要求与原考核网格（{payload.evaluation_wavelengths_nm.length}点，含波段精确边界）。常规正向图的均匀网格不替代此项验收。</p>
    <p className="search-help">{unchanged?'结构与仿真条件未改动，可检查是否复现原指标。':'当前结构或仿真条件已修改：仍可对原目标重新评估，但不能把变化直接算作精修增益。'}</p>
    {error&&<div className="alert error-alert">{error}</div>}
    <div className="workflow-actions"><button className="primary-button" disabled={busy} onClick={run}>{busy?'原网格复核中…':'按原考核网格复核当前膜系'}</button>
      <button className="small-button" disabled={!isCurrent||busy} onClick={()=>verification&&downloadText('adopted-verification.csv',spectrumCsv(verification.result),'text/csv')}>导出本次复核光谱 CSV</button>
      <button className="small-button" disabled={!isCurrent||busy} onClick={()=>verification&&downloadText('adopted-verification.json',JSON.stringify({adopted_candidate:adoption,verification},null,2))}>导出复核记录 JSON</button>
    </div>
    {!isCurrent?<p className="search-help">尚未复核当前设置；已有旧记录只作历史保存，不可当作当前成绩导出。</p>:<div className="workflow-table-scroll"><table className="workflow-table"><thead><tr><th>原网格指标</th><th>采用时基线</th><th>本次复核</th></tr></thead><tbody>{([
      ['平均违反误差','requirement_score'],['考核 MAE','weighted_mae'],['最大考核偏差','max_deviation'],['最大超差','max_violation'],['加权达标比例','pass_rate']
    ] as const).map(([label,k])=><tr key={k}><th>{label}</th><td>{adoption.candidate[k]==null?'旧记录未保存':formatPercent(adoption.candidate[k]!)}</td><td>{formatPercent(verification!.metrics[k])}</td></tr>)}</tbody></table></div>}
  </section>;
}
