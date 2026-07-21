<script setup>
import SourceMapUploader from '../../../components/SourceMapUploader.vue'
import { uploadSourceMap } from '../../../dashboard.js'
</script>

<template>
  <SourceMapUploader @upload="uploadSourceMap" />
</template>
