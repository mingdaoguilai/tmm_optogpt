import type { RefinementSettings } from '../types';
import { NumberField } from './NumberField';

export function RefinementSettingsPanel({value, onChange}: {value:RefinementSettings; onChange:(value:RefinementSettings)=>void}) {
  const patch = (change:Partial<RefinementSettings>) => onChange({...value,...change});
  return <section className="search-options">
    <label className="search-check"><input type="checkbox" checked={value.enabled} onChange={e=>patch({enabled:e.target.checked})} />生成后连续厚度精修（材料序列不变）</label>
    {value.enabled && <>
      <div className="form-grid two-columns">
        <label>不同材料序列候选数<NumberField value={value.candidate_count} onChange={candidate_count=>patch({candidate_count})} min={1} max={10} integer /></label>
        <label>每组起点数<NumberField value={value.starts} onChange={starts=>patch({starts})} min={1} max={8} integer /></label>
        <label>每组总TMM求值预算<NumberField value={value.max_evaluations} onChange={max_evaluations=>patch({max_evaluations})} min={20} max={2000} integer /></label>
        <label>全部候选优化时限 / 秒<NumberField value={value.time_budget_s} onChange={time_budget_s=>patch({time_budget_s})} min={1} max={3600} /></label>
      </div>
      <details><summary>精修数值设置</summary><div className="form-grid two-columns">
        <label>起点扰动 / 厚度范围<NumberField value={value.perturbation} onChange={perturbation=>patch({perturbation})} min={0} max={0.5} step={0.01} /></label>
        <label>损失函数<select value={value.loss} onChange={e=>patch({loss:e.target.value as RefinementSettings['loss']})}><option value="linear">普通平方损失</option><option value="huber">Huber（尺度0.02）</option></select></label>
        <label>优化网格<select value={value.optimization_step_nm} onChange={e=>patch({optimization_step_nm:Number(e.target.value) as 2|5})}><option value={5}>5 nm</option><option value={2}>2 nm</option></select></label>
        <label>最终复核网格<select value={value.verification_step_nm} onChange={e=>patch({verification_step_nm:Number(e.target.value) as 1|2})}><option value={2}>2 nm</option><option value={1}>1 nm</option></select></label>
      </div></details>
      <p className="search-help">默认选择最多5种材料序列，实际数量不足时按已有数量。预算包含数值雅可比的TMM调用，跨起点均分；总时限不含加密基线与最终复核。遵守全局/逐层边界和厚度锁。只在同一加密网格上排名改善时采用；取消保留已验证结果。网格加密不会创造原始目标中不存在的细节，连续解尚未量化为工艺厚度。</p>
    </>}
  </section>;
}
