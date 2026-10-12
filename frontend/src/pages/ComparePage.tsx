import { useEffect, useState } from "react";
import { SpectrumPlot } from "../components/SpectrumPlot";
import type { Candidate, DesignRequirements, TargetSpectrum } from "../types";
import { downloadText, formatPercent } from "../utils";

interface ComparePageProps {
  candidates: Candidate[];
  target: TargetSpectrum;
  requirements?: DesignRequirements | null;
  onUseCandidate: (candidate: Candidate) => void;
}

export function ComparePage({ candidates, target, requirements, onUseCandidate }: ComparePageProps) {
  const [channel, setChannel] = useState<"R" | "T">("R");
  const [selected, setSelected] = useState<number[]>([]);
  useEffect(() => setSelected(candidates.slice(0, 3).map((candidate) => candidate.rank)), [candidates]);
  const selectedCandidates = candidates.filter((candidate) => selected.includes(candidate.rank));
  const toggle = (rank: number) => setSelected((current) => current.includes(rank) ? current.filter((item) => item !== rank) : current.length < 4 ? [...current, rank] : current);
  const exportCandidates = () => downloadText("optogpt-candidates.json", JSON.stringify(candidates, null, 2));

  return (
    <main className="page-shell">
      <div className="page-title"><div><span className="eyebrow">CANDIDATE REVIEW</span><h1>候选比较</h1><p>最多叠加四组结构，综合检查误差和结构复杂度。</p></div><button className="secondary-button" disabled={!candidates.length} onClick={exportCandidates}>导出候选 JSON</button></div>
      {requirements && <p className="search-help">当前结果按生成时的设计要求评分：{requirements.enabled_r?"R ":""}{requirements.enabled_t?"T ":""} · {requirements.scope==="bands"?"仅指定波段":"全波段＋局部规则"}。图中未考核通道和区间仅作参考，完整规则在搜索导出文件中。</p>}
      {!candidates.length ? <section className="panel large-empty"><div className="empty-orbit">◇</div><h2>还没有候选</h2><p>先到逆向设计页面生成并验证候选。</p></section> : <>
        <section className="panel compare-chart"><div className="panel-heading"><h2>目标与候选光谱</h2><select aria-label="比较通道" value={channel} onChange={e => setChannel(e.target.value as "R" | "T")}><option value="R">反射率 R</option><option value="T">透射率 T</option></select><span>{selected.length}/4 已选择</span></div><SpectrumPlot target={target} candidates={selectedCandidates} channel={channel} /></section>
        <section className="panel candidate-table-panel"><div className="candidate-table table-header"><span>比较</span><span>排名 / 结构</span><span>光谱误差 / 参考分</span><span>复杂度</span><span>操作</span></div>{candidates.map((candidate) => <div className="candidate-table candidate-table-row" key={candidate.rank}><span><input type="checkbox" checked={selected.includes(candidate.rank)} onChange={() => toggle(candidate.rank)} /></span><span><strong>#{candidate.rank}</strong><details><summary>展开完整膜系</summary><p>{candidate.tokens.join(" / ")}</p></details></span><span><strong title="复杂度综合参考分；v3 按光谱 MAE 优先排名">综合参考 {candidate.score.toFixed(5)}</strong><small>全谱 R {formatPercent(candidate.mae_r)} · T {formatPercent(candidate.mae_t)}</small>{candidate.requirement_score!=null && <><small>违反要求 {formatPercent(candidate.requirement_score)} · 加权达标 {formatPercent(candidate.pass_rate ?? 0)}</small><details><summary>查看分波段结果</summary>{candidate.band_metrics?.map((b,i)=><p key={i}>{b.channel} {b.start_nm}–{b.end_nm} nm · {b.kind} · 最大超差 {formatPercent(b.max_violation)} · 达标 {formatPercent(b.pass_rate)}</p>)}</details></>}</span><span><strong>{candidate.layer_count} 层</strong><small>{candidate.total_thickness_nm.toFixed(0)} nm</small></span><span><button className="small-button" onClick={() => onUseCandidate(candidate)}>采用</button></span></div>)}</section>
      </>}
    </main>
  );
}
