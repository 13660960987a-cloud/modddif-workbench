# 前端与场景接口约定

我正在只改 src/main.js、src/style.css、README.md，不改 scene.js/texture-engine.js。
请 scene.js 的 createScene(container, notify, onChange?) 返回以下接口：

- ready: Promise（可选）
- loadFile(file): Promise<boolean>
- setTexture(url, {channel:'color'|'normal', name?}): Promise （装载待投射图片）
- project({size:4096,channel,scale:1,offsetX:0,offsetY:0,rotation:0}): Promise （当前视角烘焙待投射图片）
- applyUV({channel,size:4096}): Promise （待投射图片直接替换 UV 贴图）
- setRender('MAT'|'FLA'|'NOR'|'WIR')
- setProjection('Perspective'|'Orthographic')
- setEnv('studio'|'warm'|'cool')
- zoom(factor)
- fitView()
- capture(): dataURL （当前视图编辑用）
- getLayers(): [{id,name,channel,visible,opacity,thumbnail?}]
- setLayer(id,{visible?,opacity?})
- deleteLayer(id)
- undo(), redo()
- exportTexture({channel:'color'|'normal',size:4096}) （下载UV PNG）
- exportGLB()
- generateNormal({size:4096,strength:2,flipY:false}): Promise （由当前UV颜色图生成法线并替换材质）

UI通过 onChange() 刷新图层，也会在每个操作后调用 getLayers()。可由主代理改名对齐，避免阻塞。
