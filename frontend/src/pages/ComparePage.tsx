import { useEffect, useState } from "react";
import { SpectrumPlot } from "../components/SpectrumPlot";
import type { Candidate, TargetSpectrum } from "../types";
import { downloadText, formatPercent } from "../utils";

interface ComparePageProps {
  candidates: Candidate[];
  target: TargetSpectrum;
  onUseCandidate: (candidate: Candidate) => void;
}

export function ComparePage({ candidates, target, onUseCandidate }: ComparePageProps) {
  const [selected, setSelected] = useState<number[]>([]);
  useEffect(() => setSelected(candidates.slice(0, 3).map((candidate) => candidate.rank)), [candidates]);
  const selectedCandidates = candidates.filter((candidate) => selected.includes(candidate.rank));
  const toggle = (rank: number) => setSelected((current) => current.includes(rank) ? current.filter((item) => item !== rank) : current.length < 4 ? [...current, rank] : current);
  const exportCandidates = () => downloadText("optogpt-candidates.json", JSON.stringify(candidates, null, 2));

  return (
    <main className="page-shell">
      <div className="page-title"><div><span className="eyebrow">CANDIDATE REVIEW</span><h1>候选比较</h1><p>最多叠加四组结构，综合检查误差和结构复杂度。</p></div><button className="secondary-button" disabled={!candidates.length} onClick={exportCandidates}>导出候选 JSON</button></div>
      {!candidates.length ? <section className="panel large-empty"><div className="empty-orbit">◇</div><h2>还没有候选</h2><p>先到逆向设计页面生成并验证候选。</p></section> : <>
        <section className="panel compare-chart"><div className="panel-heading"><h2>目标与候选反射率</h2><span>{selected.length}/4 已选择</span></div><SpectrumPlot target={target} candidates={selectedCandidates} /></section>
        <section className="panel candidate-table-panel"><div className="candidate-table table-header"><span>比较</span><span>排名 / 结构</span><span>误差</span><span>复杂度</span><span>操作</span></div>{candidates.map((candidate) => <div className="candidate-table candidate-table-row" key={candidate.rank}><span><input type="checkbox" checked={selected.includes(candidate.rank)} onChange={() => toggle(candidate.rank)} /></span><span><strong>#{candidate.rank}</strong><small>{candidate.tokens.join(" / ")}</small></span><span><strong>{formatPercent(candidate.score)}</strong><small>R {formatPercent(candidate.mae_r)} · T {formatPercent(candidate.mae_t)}</small></span><span><strong>{candidate.layer_count} 层</strong><small>{candidate.total_thickness_nm.toFixed(0)} nm</small></span><span><button className="small-button" onClick={() => onUseCandidate(candidate)}>采用</button></span></div>)}</section>
      </>}
    </main>
  );
}
