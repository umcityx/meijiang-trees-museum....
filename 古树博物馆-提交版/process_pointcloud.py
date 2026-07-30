#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
处理千年古梅两帧 LAS 扫描 -> 单棵树的轻量点云 .ply
- 流式分块读取（不爆内存）；命中的点直接写入 .body 文件，绝不在内存堆积
- Pass A: z 直方图(bincount)找密集地面层 G
- Pass B: 密集地面带质心 = 树基 XY 中心
- Pass C: 以树基为中心裁 ROI，双体素抽稀，流式写出
- 双体素抽稀：地面粗(8cm, cap 0.3M)，树细(4cm, cap 2.5M)
- 输出二进制 PLY (Z 轴朝上, 居中), 存 public/pointclouds/54.ply
"""
import os, time, json, struct
import numpy as np
import laspy

BASE = r'F:/university/大二下/大创/古树扫描数据/LAS文件'
FILES = ['1千年古梅 1.las', '2千年古梅 2.las']
OUT = os.path.join(os.path.dirname(__file__), 'public', 'pointclouds', '54.ply')
BODY = OUT + '.body'

ROI_HALF = 25.0          # 水平半宽 25m -> 50m 框，容纳冠幅+近地
V_TREE, CAP_TREE = 0.04, 2_500_000   # 树: 4cm, 上限 2.5M（总量低于上限->不截断->完整树高）
V_GND,  CAP_GND  = 0.08, 300_000     # 地面: 8cm, 上限 0.3M
BAND = 0.5

X0, Y0 = 415000.0, 2690000.0   # X/Y 体素基准
CHUNK = 3_000_000
REC = struct.Struct('<3f3B')   # x,y,z(f32) + r,g,b(u8) = 15 bytes

def pack_keys(x, y, z, v, zbase):
    ix = np.floor((x - X0) / v).astype(np.int64)
    iy = np.floor((y - Y0) / v).astype(np.int64)
    iz = np.floor((z - zbase) / v).astype(np.int64)
    return (ix << 36) | (iy << 18) | iz

def collect(use_v, cap, seen, xs, ys, zs, rs, gs, bs, zbase, bodyf, counter):
    n = xs.shape[0]
    if n == 0:
        return len(seen) >= cap
    keys = pack_keys(xs, ys, zs, use_v, zbase)
    uniq, first = np.unique(keys, return_index=True)
    for k in uniq.tolist():
        if k in seen:
            continue
        if len(seen) >= cap:
            return True
        idx = first[np.where(uniq == k)[0][0]]
        seen.add(k)
        bodyf.write(REC.pack(xs[idx], ys[idx], zs[idx], int(rs[idx]), int(gs[idx]), int(bs[idx])))
        counter[0] += 1
    return len(seen) >= cap

stats = {'files': {}, 'total_read': 0, 't0': time.time()}

# ---- Pass A: z 直方图（bincount，单遍），找密集地面层 ----
HLO, HHI, HBINS = 360.0, 440.0, 160
hist = np.zeros(HBINS, dtype=np.int64)
zmin = zmax = None
for fn in FILES:
    with laspy.open(os.path.join(BASE, fn)) as reader:
        for chunk in reader.chunk_iterator(CHUNK):
            z = np.asarray(chunk.z, np.float64)
            zc, zx = z.min(), z.max()
            if zmin is None or zc < zmin: zmin = zc
            if zmax is None or zx > zmax: zmax = zx
            bi = np.clip(((z - HLO) * (HBINS / (HHI - HLO))).astype(np.int64), 0, HBINS - 1)
            hist += np.bincount(bi, minlength=HBINS)
peak = int(np.argmax(hist))
G = HLO + (peak + 0.5) * (HHI - HLO) / HBINS
print(f"[zrange] zmin={zmin:.2f} zmax={zmax:.2f}")
print(f"[ground] 密集地面层 G={G:.2f}m  (bin #{peak}, {int(hist[peak]):,} 点)")

Z0_BASE = G - 10.0
GROUND_Z = G + 1.5
Z_LO, Z_HI = G - 2.0, zmax + 3.0

# ---- Pass B: 密集地面带质心 = 树基 XY 中心 ----
sx = sy = cnt_low = 0
for fn in FILES:
    with laspy.open(os.path.join(BASE, fn)) as reader:
        for chunk in reader.chunk_iterator(CHUNK):
            z = np.asarray(chunk.z, np.float64)
            m = (z >= G - 1.0) & (z <= G + 2.0)
            if not m.any():
                continue
            x = np.asarray(chunk.x, np.float64)
            y = np.asarray(chunk.y, np.float64)
            sx += x[m].sum(); sy += y[m].sum(); cnt_low += int(m.sum())
CX = sx / cnt_low
CY = sy / cnt_low
print(f"[center] CX={CX:.2f} CY={CY:.2f} n_ground={cnt_low:,}")

# ---- Pass C: 裁 ROI + 双体素抽稀（流式写出） ----
tree_seen, gnd_seen = set(), set()
counter = [0]
t0 = time.time()
with open(BODY, 'wb') as bodyf:
    for fn in FILES:
        fp = os.path.join(BASE, fn)
        with laspy.open(fp) as reader:
            cnt = 0
            f0 = time.time()
            for chunk in reader.chunk_iterator(CHUNK):
                x = np.asarray(chunk.x, np.float64)
                y = np.asarray(chunk.y, np.float64)
                z = np.asarray(chunk.z, np.float64)
                r = (np.asarray(chunk.red) >> 8).astype(np.uint8)
                g = (np.asarray(chunk.green) >> 8).astype(np.uint8)
                b = (np.asarray(chunk.blue) >> 8).astype(np.uint8)
                cnt += x.shape[0]

                m = (np.abs(x - CX) <= ROI_HALF) & (np.abs(y - CY) <= ROI_HALF) & (z >= Z_LO) & (z <= Z_HI)
                if not m.any():
                    continue
                x, y, z, r, g, b = x[m], y[m], z[m], r[m], g[m], b[m]

                gm = z < GROUND_Z
                if gm.any() and len(gnd_seen) < CAP_GND:
                    collect(V_GND, CAP_GND, gnd_seen, x[gm], y[gm], z[gm], r[gm], g[gm], b[gm], Z0_BASE, bodyf, counter)
                if (~gm).any() and len(tree_seen) < CAP_TREE:
                    collect(V_TREE, CAP_TREE, tree_seen, x[~gm], y[~gm], z[~gm], r[~gm], g[~gm], b[~gm], Z0_BASE, bodyf, counter)

                if len(tree_seen) >= CAP_TREE and len(gnd_seen) >= CAP_GND:
                    break

            stats['files'][fn] = {'read': cnt, 'sec': round(time.time() - f0, 1)}
            stats['total_read'] = stats['total_read'] + cnt
        print(f"[ok] {fn}: read={cnt:,}  tree_pts={len(tree_seen):,} gnd_pts={len(gnd_seen):,}  written={counter[0]:,}  elapsed={time.time()-t0:.1f}s")

n = counter[0]
# 组装最终 PLY：读回 body（15 字节/记录），居中后写出
dt = np.dtype([('x', '<f4'), ('y', '<f4'), ('z', '<f4'), ('r', 'u1'), ('g', 'u1'), ('b', 'u1')])
with open(BODY, 'rb') as f:
    arr = np.frombuffer(f.read(), dtype=dt, count=n).copy()
xs = (arr['x'].astype(np.float64) - CX).astype(np.float32)
ys = (arr['y'].astype(np.float64) - CY).astype(np.float32)
zs = (arr['z'].astype(np.float64) - G).astype(np.float32)
arr['x'], arr['y'], arr['z'] = xs, ys, zs

with open(OUT, 'wb') as f:
    hdr = (f"ply\nformat binary_little_endian 1.0\n"
           f"element vertex {n}\n"
           f"property float x\nproperty float y\nproperty float z\n"
           f"property uchar red\nproperty uchar green\nproperty uchar blue\n"
           f"end_header\n")
    f.write(hdr.encode('ascii'))
    f.write(arr.tobytes())

try:
    os.remove(BODY)
except OSError:
    pass

stats['out_points'] = n
stats['out_bytes'] = os.path.getsize(OUT)
stats['out_bbox'] = [round(float(xs.min()),2), round(float(xs.max()),2),
                     round(float(ys.min()),2), round(float(ys.max()),2),
                     round(float(zs.min()),2), round(float(zs.max()),2)]
stats['center'] = [round(CX,2), round(CY,2)]
stats['ground_G'] = round(G,2)
stats['total_sec'] = round(time.time() - t0, 1)
with open(os.path.join(os.path.dirname(__file__), 'process_pointcloud.log'), 'w', encoding='utf-8') as f:
    json.dump(stats, f, ensure_ascii=False, indent=2)
print(f"[done] center=({CX:.2f},{CY:.2f}) G={G:.2f} points={n:,}  size={stats['out_bytes']/1024/1024:.1f}MB  bbox={stats['out_bbox']}  time={stats['total_sec']}s")
