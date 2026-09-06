import { expect, test } from 'bun:test';
import * as THREE from 'three';
import { placeSceneCards, createSceneCardLayout, type ScreenCard } from './scene-card-layout';

const card = (id: string, patch: Partial<ScreenCard> = {}): ScreenCard => ({ id, x: 300, y: 300, width: 180, height: 45, depth: 10, priority: 0, ...patch });
const overlaps = (a: ReturnType<typeof placeSceneCards>[number], b: ReturnType<typeof placeSceneCards>[number]) =>
 a.x+a.dx-a.width/2 < b.x+b.dx+b.width/2 && a.x+a.dx+a.width/2 > b.x+b.dx-b.width/2 &&
 a.y+a.dy > b.y+b.dy-b.height && a.y+a.dy-a.height < b.y+b.dy;

test('overlapping cards stack near their plants without covering one another', () => {
 const input = [card('a'),card('b',{x:330,depth:12}),card('c',{x:350,depth:14})];
 const result=placeSceneCards(input,1280,900);
 expect(result).toHaveLength(3);
 for(let i=0;i<result.length;i++)for(let j=i+1;j<result.length;j++)expect(overlaps(result[i]!,result[j]!)).toBe(false);
 expect(result[0]!.dy).toBe(0);
 expect(result.every(p=>Math.abs(p.dx)<73 && p.dy>=-160)).toBe(true);
 expect(placeSceneCards([...input].reverse(),1280,900)).toEqual(result);
});

test('phone edges stay within bounds, distant unreadable cards yield, and highlights win congestion', () => {
 const crowded=Array.from({length:12},(_,i)=>card(`${i}`,{x:200,depth:i+1,priority:i===11?2:0}));
 const result=placeSceneCards(crowded,390,844);
 expect(result[0]!.id).toBe('11');expect(result.length).toBeLessThan(crowded.length);
 for(const p of result){expect(p.x+p.dx-p.width/2).toBeGreaterThanOrEqual(16);expect(p.x+p.dx+p.width/2).toBeLessThanOrEqual(374);}
 expect(placeSceneCards([card('tiny',{width:40}),card('behind',{depth:-1}),card('offscreen',{x:-500}),card('bad',{x:NaN})],390,844)).toEqual([]);
});

test('hover keeps an already displaced card in its current slot', () => {
 const result=placeSceneCards([card('other'),card('hover',{priority:2,preferred:{dx:0,dy:-53}})],1280,900);
 expect(result[0]!.dy).toBe(-53);expect(result).toHaveLength(2);expect(overlaps(result[0]!,result[1]!)).toBe(false);
});

test('rendered card bounds follow sprite raycasts, anchors remain fixed, and reset restores sprites', () => {
 const layout=createSceneCardLayout(), camera=new THREE.PerspectiveCamera(50,1280/900,.1,1000);
 camera.position.set(0,0,10);camera.updateMatrixWorld();
 const root=new THREE.Group();root.add(layout.group);
 const labels=[0,1].map(i=>{const label=new THREE.Sprite(new THREE.SpriteMaterial());label.scale.set(3,.75,1);label.center.set(.5,0);label.userData.pick={kind:'idea',key:`${i}`};root.add(label);return label});
 const cards=labels.map((label,i)=>({id:`${i}`,label,priority:0}));
 layout.update(camera,1280,900,cards);
 const rects=layout.rects();expect(rects).toHaveLength(2);
 const ray=new THREE.Raycaster();
 for(const r of rects){const x=r.left+r.width/2,y=r.top+r.height/2;ray.setFromCamera(new THREE.Vector2(x/640-1,1-y/450),camera);expect(ray.intersectObject(labels[Number(r.id)]!)).toHaveLength(1);expect(layout.pick(x,y)).toEqual({kind:'idea',key:r.id});}
 expect(labels.every(label=>label.position.length()===0)).toBe(true);
 layout.reset();for(const label of labels){expect(label.center.toArray()).toEqual([.5,0]);expect(label.scale.toArray()).toEqual([3,.75,1]);expect(label.visible).toBe(true);}
 expect(layout.pick(640,430)).toBeNull();layout.dispose();labels.forEach(label=>label.material.dispose());
});

test('a highlighted distant plant keeps a readable card over consecutive frames', () => {
 const layout=createSceneCardLayout(), camera=new THREE.PerspectiveCamera(50,1280/900,.1,1000);
 camera.position.z=100;
 const label=new THREE.Sprite(new THREE.SpriteMaterial()); label.scale.set(3,.75,1);label.center.set(.5,0);
 const input=[{id:'far',label,priority:0}];
 layout.update(camera,1280,900,input);expect(label.visible).toBe(false);
 input[0]!.priority=2;
 for(let frame=0;frame<20;frame++) {
  layout.update(camera,1280,900,input);expect(label.visible).toBe(true);
  expect(layout.rects()[0]!.width).toBeGreaterThanOrEqual(119);
 }
 input[0]!.priority=0;layout.update(camera,1280,900,input);expect(label.visible).toBe(false);
 layout.dispose();label.material.dispose();
});
