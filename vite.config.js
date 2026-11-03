import { defineConfig } from 'vite';
export default defineConfig({server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{'/api':{target:'http://127.0.0.1:'+(process.env.WORKBENCH_API_PORT||8787),changeOrigin:true}}},preview:{host:'127.0.0.1',proxy:{'/api':{target:'http://127.0.0.1:'+(process.env.WORKBENCH_API_PORT||8787),changeOrigin:true}}}});
