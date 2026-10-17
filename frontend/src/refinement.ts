import type { RefinementSettings } from './types';

export const defaultRefinement: RefinementSettings = {
  enabled:false, candidate_count:5, starts:2, max_evaluations:160,
  time_budget_s:180, perturbation:0.1, optimization_step_nm:5,
  verification_step_nm:2, loss:'linear',
};

export function validateRefinement(value: RefinementSettings) {
  if (!value || typeof value.enabled !== 'boolean'
      || ![2,5].includes(value.optimization_step_nm) || ![1,2].includes(value.verification_step_nm)
      || !['linear','huber'].includes(value.loss)) throw new Error('精修设置无效');
  const ranges: [number,number,number,boolean][] = [
    [value.candidate_count,1,10,true], [value.starts,1,8,true],
    [value.max_evaluations,20,2000,true], [value.time_budget_s,1,3600,false],
    [value.perturbation,0,0.5,false],
  ];
  if (ranges.some(([n,min,max,integer])=> !Number.isFinite(n) || n<min || n>max || (integer && !Number.isInteger(n)))) throw new Error('精修预算或扰动范围无效');
}
