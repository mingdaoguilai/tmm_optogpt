import {useEffect,useRef,useState} from 'react';
import {SpectrumPlot} from '../components/SpectrumPlot';
import {CandidateMetrics,BandMetrics} from '../components/CandidateMetrics';
import type {Candidate,CandidateReview,DesignRequirements,TargetSpectrum} from '../types';
import {api} from '../api';
import {defaultRequirements} from '../designRequirements';
import {downloadText} from '../utils';
import {fingerprint,initialCandidate,spectrumCsv,structureCsv} from '../workflow';

interface Props {
  candidates:Candidate[]; target:TargetSpectrum; requirements?:DesignRequirements|null;
  onUseCandidate:(candidate:Candidate,variant?:'initial'|'current')=>void;
  onExportDesign:()=>void;
  onCandidateReviewed:(source:Candidate,updated:Candidate)=>void;
}

export function ComparePage({candidates,target,requirements,onUseCandidate,onExportDesign,onCandidateReviewed}:Props) {
  const [channel,setChannel]=useState<'R'|'T'>('R');
  const [selected,setSelected]=useState<number[]>([]);
  const [showInitial,setShowInitial]=useState(true);
  const [reviews,setReviews]=useState<Record<number,{key:string;data:CandidateReview}>>({});
  const [pending,setPending]=useState<Record<number,string>>({});
  const [errors,setErrors]=useState<Record<number,{key:string;message:string}>>({});
  const selectionKey=fingerprint(candidates.map(c=>({rank:c.rank,tokens:c.tokens,layers:c.layers})));
  useEffect(()=>{setSelected(candidates.slice(0,3).map(c=>c.rank));},[selectionKey]);
  const rules=requirements??defaultRequirements;
  const context=fingerprint({candidates,target,requirements:rules});
  const latestContext=useRef(context);latestContext.current=context;
  const keyFor=(c:Candidate)=>fingerprint({candidate:c,target,requirements:rules});
  const reviewed=(c:Candidate)=>reviews[c.rank]?.key===keyFor(c)?reviews[c.rank].data:undefined;
  const review=async(c:Candidate)=>{
    const key=keyFor(c);
    setPending(prev=>({...prev,[c.rank]:key}));
    setErrors(prev=>({...prev,[c.rank]:{key,message:''}}));
    try {
      const data=await api.reviewCandidate(c,target,rules);
      if(latestContext.current!==context)return;
      setReviews(prev=>({...prev,[c.rank]:{key:keyFor(data.current),data}}));
      onCandidateReviewed(c,data.current);
      return data;
    } catch(e) {setErrors(prev=>({...prev,[c.rank]:{key,message:e instanceof Error?e.message:String(e)}}));}
    finally {setPending(prev=>prev[c.rank]===key?{...prev,[c.rank]:''}:prev);}
  };
  const use=async(c:Candidate,variant:'initial'|'current')=>{
    const result=reviewed(c)??await review(c);
    if(result) onUseCandidate(result.current,variant);
  };
  const selectedCandidates=candidates.filter(c=>selected.includes(c.rank));
  const toggle=(rank:number)=>setSelected(old=>old.includes(rank)?old.filter(n=>n!==rank):old.length<4?[...old,rank]:old);

  return <main className="page-shell">
    <div className="page-title"><div><span className="eyebrow">CANDIDATE REVIEW · V4</span><h1>候选比较与采用</h1><p>初始解与当前精修解分别保留；采用前用实际厚度复算，不从 token 重建。</p></div><button className="secondary-button" disabled={!candidates.length} onClick={onExportDesign}>导出完整设计包 JSON</button></div>
    <p className="search-help">按生成时的目标快照和要求评分：{rules.enabled_r?'R ':''}{rules.enabled_t?'T ':''} · {rules.scope==='bands'?'仅指定波段':'全波段＋局部规则'}。未考核通道/区间仅供参考；最大考核偏差和最大超差不是全谱最大误差。达标比例是离散网格验收，不保证点间也全部满足。</p>
    {!candidates.length?<section className="panel large-empty"><h2>还没有候选</h2><p>先到逆向设计页生成候选，或打开保存的项目。</p></section>:<>
      <section className="panel compare-chart"><div className="panel-heading"><h2>目标与候选光谱</h2><select aria-label="比较通道" value={channel} onChange={e=>setChannel(e.target.value as 'R'|'T')}><option value="R">反射率 R</option><option value="T">透射率 T</option></select><label className="auto-toggle"><input type="checkbox" checked={showInitial} onChange={e=>setShowInitial(e.target.checked)}/>叠加精修前光谱</label><span>{selected.length}/4</span></div><SpectrumPlot target={target} candidates={selectedCandidates.map(c=>reviewed(c)?.current??c)} channel={channel} showInitial={showInitial}/></section>
      <section className="panel workflow-selector"><div className="panel-heading"><h2>选择要比较的候选（最多4组）</h2></div><div className="workflow-actions">{candidates.map(c=><label className="auto-toggle" key={c.rank}><input type="checkbox" checked={selected.includes(c.rank)} onChange={()=>toggle(c.rank)}/>#{c.rank} · {c.layer_count}层</label>)}</div></section>
      {selectedCandidates.map(source=>{
        const c=reviewed(source)?.current??source, initial=reviewed(source)?.initial??initialCandidate(c);
        const busy=pending[source.rank]===keyFor(source), err=errors[source.rank];
        const layers=(x:Candidate)=>x.layers.map(l=>`${l.material} ${l.thickness_nm.toFixed(4)} nm`).join(' / ');
        return <section className="panel workflow-card" key={source.rank}>
          <div className="panel-heading"><h2>#{c.rank} · {c.layer_count}层 · {c.total_thickness_nm.toFixed(3)} nm</h2><span>{reviewed(source)?'已按原网格复算':`${c.simulation.wavelengths_nm.length}点 · 已保存结果`}</span></div>
          {err?.key===keyFor(source)&&err.message&&<div className="alert error-alert">{err.message}</div>}
          <div className="workflow-actions">
            <button className="small-button" disabled={busy} onClick={()=>review(source)}>{busy?'复算中…':'按原网格复算前后结果'}</button>
            <button className="primary-button" disabled={busy} onClick={()=>use(source,'current')}>采用当前结果并去正向页</button>
            {initial&&<button className="small-button" disabled={busy} onClick={()=>use(source,'initial')}>采用精修初值</button>}
          </div>
          <CandidateMetrics current={c} initial={initial}/>
          <details><summary>分波段前后指标</summary><BandMetrics current={c} initial={initial}/></details>
          {initial&&<p className="workflow-structure">初值：{layers(initial)}</p>}
          <p className="workflow-structure">当前：{layers(c)}</p>
          {c.refinement&&<p className="search-help">{c.refinement.message} · 求值 {c.refinement.evaluations} · 已尝试起点 {c.refinement.starts_completed} · {c.refinement.elapsed_s.toFixed(1)} s。连续解尚未工艺量化。</p>}
          <details><summary>原始模型token与停止信息</summary><p className="workflow-structure">{c.tokens.join(' / ')}</p>{c.refinement?.solver_messages.map((m,i)=><p key={i}>{m}</p>)}</details>
          <div className="workflow-actions">
            <button className="small-button" onClick={()=>downloadText(`candidate-${c.rank}-current-layers.csv`,structureCsv(c),'text/csv')}>当前厚度 CSV</button>
            <button className="small-button" onClick={()=>downloadText(`candidate-${c.rank}-current-spectrum.csv`,spectrumCsv(c.simulation),'text/csv')}>当前光谱 CSV</button>
            {initial&&<button className="small-button" onClick={()=>downloadText(`candidate-${c.rank}-initial-layers.csv`,structureCsv(initial),'text/csv')}>初值厚度 CSV</button>}
          </div>
        </section>;
      })}
    </>}
  </main>;
}
