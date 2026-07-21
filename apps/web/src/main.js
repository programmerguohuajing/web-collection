/**
 * @file Web 仪表盘入口
 * 创建 Vue 应用，注册 Element Plus 插件并挂载到 #app。
 */
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { router } from './router/index.js'
import './style.css'

createApp(App).use(ElementPlus, { locale: zhCn }).use(router).mount('#app')
