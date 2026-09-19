import { useEffect, useState } from 'react';
import Plot from 'react-plotly.js';
import { NumberField } from './NumberField';
import { downloadText } from '../utils';

type Detail = { id: string; source: string; wavelengths_nm: number[]; n: number[]; k: number[]; interpolation: string };
export function MaterialDetail({ material, close }: { material: string; close: () => void }) {
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [wavelength, setWavelength] = useState(550);
  const [table, setTable] = useState(false);
  useEffect(() => { const controller = new AbortController(); setData(null); setError('');
    fetch(`/api/materials/${encodeURIComponent(material)}`, { signal: controller.signal }).then(async r => { if (!r.ok) throw Error('材料数据读取失败'); return r.json(); }).then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message); });
    return () => controller.abort();
  }, [material]);
  useEffect(() => { const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [close]);
  const lookup = (values: number[]) => {
    if (!data) return '—'; const x = data.wavelengths_nm;
    if (wavelength < x[0] || wavelength > x[x.length - 1]) return '超出数据范围';
    const i = x.findIndex(v => v >= wavelength); if (!i || x[i] === wavelength) return values[i].toFixed(6);
    return (values[i-1] + (values[i]-values[i-1]) * (wavelength-x[i-1]) / (x[i]-x[i-1])).toFixed(6);
  };
  return <div className="modal-backdrop" onClick={close}><section className="material-detail panel" role="dialog" aria-modal="true" aria-label={`${material} 光学数据`} onClick={e => e.stopPropagation()}><div className="panel-heading"><h2>{material} · 光学常数</h2><button autoFocus className="small-button" onClick={close}>关闭 ×</button></div>
    {error && <p role="alert">{error}</p>}{!data && !error && <p>正在读取材料数据…</p>}
    {data && <div className="detail-body"><p>{data.source} · {data.wavelengths_nm.length} 点 · {data.interpolation}</p><p>范围 {data.wavelengths_nm[0]}–{data.wavelengths_nm[data.wavelengths_nm.length-1]} nm；原始文献来源未核实。</p>
    <div className="detail-toolbar"><label>查询波长<NumberField value={wavelength} onChange={setWavelength} unit="nm" min={0.001}/></label><span>n = {lookup(data.n)}<br/>k = {lookup(data.k)}<br/><small>{data.wavelengths_nm.includes(wavelength) ? '原始采样点' : '插值查询'}</small></span><button className="secondary-button" onClick={() => setTable(!table)}>{table ? '查看曲线' : '原始数据表'}</button><button className="secondary-button" onClick={() => downloadText(`${material}-nk.csv`, ['wavelength_nm,n,k', ...data.wavelengths_nm.map((x,i) => `${x},${data.n[i]},${data.k[i]}`)].join('\n'), 'text/csv')}>导出 CSV</button></div>
    {table ? <div className="data-table"><table><thead><tr><th>λ / nm</th><th>n</th><th>k</th></tr></thead><tbody>{data.wavelengths_nm.map((x,i) => <tr key={i}><td>{x}</td><td>{data.n[i]}</td><td>{data.k[i]}</td></tr>)}</tbody></table></div> : <Plot data={[
      { x: data.wavelengths_nm, y: data.n, name: 'n', type: 'scatter', mode: 'lines', line: {color:'#76a9ff'}, xaxis:'x', yaxis:'y' },
      { x: data.wavelengths_nm, y: data.k, name: 'k', type: 'scatter', mode: 'lines', line: {color:'#77dec0'}, xaxis:'x2', yaxis:'y2' }
    ]} layout={{height:440, paper_bgcolor:'transparent', plot_bgcolor:'transparent', font:{color:'#cbd6e8'}, margin:{l:55,r:20,t:30,b:45}, grid:{rows:2,columns:1,pattern:'independent'}, xaxis:{matches:'x2'}, xaxis2:{title:{text:'波长 / nm'}}, yaxis:{title:{text:'n'}}, yaxis2:{title:{text:'k'}}, hovermode:'x unified'}} config={{responsive:true,displaylogo:false}} useResizeHandler style={{width:'100%'}}/>}</div>}
  </section></div>;
}
