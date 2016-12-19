// Copyright 2014, 2015, 2016 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

// TODO post split, reduce deps here
define(['./basic', '../events', '../gltools', '../math', '../types', '../values'],
       (widgets_basic, events, gltools, math, types, values) => {
  'use strict';
  
  const Block = widgets_basic.Block;
  const DerivedCell = values.DerivedCell;
  const Enum = types.Enum;
  const Radio = widgets_basic.Radio;
  const Range = types.Range;
  const SingleQuad = gltools.SingleQuad;
  const StorageCell = values.StorageCell;
  const Toggle = widgets_basic.Toggle;
  const dB = math.dB;
  const makeBlock = values.makeBlock;
  const mod = math.mod;
  
  const exports = Object.create(null);
  
  function ScopeParameters(storage) {
    function sc(key, type, value) {
      return new StorageCell(sessionStorage, type, value, key);
    }
    return makeBlock({
      paused: sc('paused', Boolean, false),
      axes: sc('axes', new Enum({
        't,ch1,1': 'AT',
        't,ch2,1': 'BT',
        'ch1,ch2,t': 'XY',
        'ch2,ch1,t': 'XY Rev',
        '1-2,1+2,t': 'Stereo'
      }), 't,ch1,1'),
      draw_line: sc('draw_line', Boolean, false),  // TODO better name
      history_samples: sc('history_samples', new Range([[256, 256], [512, 512], [1024, 1024], [2048, 2048], [4096, 4096], [8192, 8192], [16384, 16384]/*, [32768, 32768], [65536, 65536]*/], true, true), 8192),
      time_scale: sc('time_scale', new Range([[128, 16384]], false, false), 1024),
      gain: sc('gain', new Range([[-50, 50]], false, false), 0),
      intensity: sc('intensity', new Range([[1.01/256, 10.0]], true, false), 1.0),
      focus_falloff: sc('focus_falloff', new Range([[0.1, 3]], false, false), 0.8),
      persistence_gamma: sc('persistence_gamma', new Range([[1, 100]], true, false), 10.0),
      invgamma: sc('invgamma', new Range([[0.5, 2]], false, false), 1.0)
    });
  }
  exports.ScopeParameters = ScopeParameters;
  
  function ScopePlot(config) {
    const storage = config.storage;
    const scheduler = config.scheduler;
    const scopeAndParams = config.target.depend(config.rebuildMe);
    const parameters = scopeAndParams.parameters.depend(config.rebuildMe);
    const scopeCell = scopeAndParams.scope;
    
    const canvas = config.element;
    if (canvas.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
    }
    this.element = canvas;
    
    const fakeDataMode = false;
    
    const numberOfChannels = 2;  // not directly changeable; this is for documentation
    const interpScale = 10;
    
    const kernelRadius = 10;

    const gl = gltools.getGL(config, canvas, {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false
    });
    
    if (!( gl.getExtension('OES_texture_float')
        && gl.getExtension('OES_texture_float_linear')
        && gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) >= 1)) {
      // TODO: Add a way to provide a nicer-formatted error message.
      throw Exception('Required WebGL feastures not available.');
    }
    
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    
    const scopeDataTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, scopeDataTexture);
    // TODO: Implement more accurate than linear filtering in the shader, and set this to NEAREST.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    // Texel index into which to write the newest data.
    let circularBufferPtr;
    
    // These are initialized by configureDataBuffer.
    let numberOfSamples;
    let numberOfDots;
    const timeBuffer = gl.createBuffer();
    // scopeDataArray is a copy of the texture contents, not used for drawing but is used to calculate the trigger position.
    let scopeDataArray = new Float32Array(0);
    
    // Contents are indexes like circularBufferPtr, points at where we triggered, is itself a circular buffer
    const NO_TRIGGER = -1;
    const triggerSampleIndexes = new Int32Array(20);
    triggerSampleIndexes.fill(NO_TRIGGER);
    let triggerAddPtr = 0;
    let triggerInhibition = 0;
    
    // Takes accumulated dots and applies horizontal kernel.
    const postProcessor1 = new gltools.PostProcessor(gl, {
      // This is not ideal: since we just want to accumulate dots, the least wasteful would be a 16 or 32-bit integer single-component (LUMINANCE) buffer. But neither larger than 8-bit integers nor LUMINANCE are allowed by WebGL for a framebuffer texture.
      format: gl.RGBA,
      type: gl.FLOAT,
      fragmentShader: ''
        + 'const int radius = ' + kernelRadius + ';\n'
        + 'const int diameter = radius * 2 + 1;\n'
        + 'uniform mediump float kernel[diameter];\n'
        + 'void main(void) {\n'
        + '  highp vec3 sum = vec3(0.0);\n'
        + '  for (int kx = 0; kx < diameter; kx++) {\n'
      + '      sum += kernel[kx] * texture2D(pp_texture, pp_texcoord + vec2(float(kx - radius), 0.0) / pp_size).rgb;'
        + '  }\n'
        + '  gl_FragColor = vec4(sum, 1.0);'
        + '}'
    });
    
    const postProcessor2 = new gltools.PostProcessor(gl, {
      format: gl.RGBA,
      type: gl.FLOAT,
      fragmentShader: ''
        + 'uniform mediump float intensity;\n'
        + 'uniform mediump float invgamma;\n'
        + 'const int radius = ' + kernelRadius + ';\n'
        + 'const int diameter = radius * 2 + 1;\n'
        + 'uniform mediump float kernel[diameter];\n'
        + 'void main(void) {\n'
        + '  highp vec3 sum = vec3(0.0);\n'
        + '  for (int ky = 0; ky < diameter; ky++) {\n'
        + '    sum += kernel[ky] * texture2D(pp_texture, pp_texcoord + vec2(0.0, float(ky - radius)) / pp_size).rgb;'
        + '  }\n'
        + '  gl_FragColor = vec4(pow(intensity * sum, vec3(invgamma)) * vec3(0.1, 1.0, 0.5), 1.0);'
        + '}'
    });
    
    // vertex shader scraps for FIR filtering -- couldn't get it to work but this should still be the skeleton of it
    //  + 'uniform mediump float filter[37];\n'
    //  + 'mediump vec2 rawsignal(mediump float tsub) {\n'  // zero-stuffed signal
    //  + '  return mod(tsub / interpStep, 10.0) < 1.00\n'
    //  + '      ? texture2D(scopeData, vec2(tsub, 0.5)).ra\n'
    //  + '      : vec2(0.0);\n'
    //  + '}\n'
    //  + '  for (int i = -18; i <= 18; i++) {\n'
    //  + '    signal += filter[i] * rawsignal(time + float(i) * interpStep);\n'
    //  + '  }\n'
    
    const vertexShaderSource = ''
      + 'attribute mediump float relativeTime;\n'
      + 'uniform float interpStep;\n'
      + 'uniform mat4 projection;\n'
      + 'uniform mediump float bufferCutPoint;\n'
      + 'uniform sampler2D scopeData;\n'
      + 'varying lowp float v_z;\n'
      + 'void main(void) {\n'
      + '  mediump float bufferTime = mod(bufferCutPoint + relativeTime, 1.0);\n'
      + '  gl_PointSize = 1.0;\n'
      + '  mediump vec2 signal = texture2D(scopeData, vec2(bufferTime, 0.5)).ra;\n'
      + '  vec4 basePos = vec4(signal, relativeTime * 2.0 - 1.0, 1.0);\n'
      + '  vec4 projected = basePos * projection;\n'
      + '  gl_Position = vec4(clamp(projected.x, -0.999, 0.999), clamp(projected.y, -0.999, 0.999), 0.0, projected.w);\n' // show over-range in x and y and don't clip to z
      + '  v_z = (projected.z / projected.w) / 2.0 + 0.5;\n'  // 0-1 range instead of -1-1
      + '}\n';
    const fragmentShaderSource = ''
      + 'varying lowp float v_z;\n'
      + 'uniform mediump float persistence_gamma;\n'
      + 'void main(void) {\n'
      // TODO: Experiment with ways we can use the currently-wasted three different components.
      // Note: the pow() here (rather than exponential decay) is not realistic but seems to produce good results.
      + '  gl_FragColor = vec4(vec3(pow(v_z, persistence_gamma)), 1.0);\n'
      + '}\n';
    const program = gltools.buildProgram(gl, vertexShaderSource, fragmentShaderSource);
    const att_relativeTime = gl.getAttribLocation(program, 'relativeTime');
    gl.uniform1i(gl.getUniformLocation(program, 'scopeData'), 0);  // texture
    
    const configureDataBuffer = config.boundedFn(function configureDataBufferImpl() {
      numberOfSamples = parameters.history_samples.depend(configureDataBuffer);
      numberOfDots = (numberOfSamples - 1) * interpScale + 1;  // avoids having any end-to-beginning wraparound points
      
      circularBufferPtr = 0;  // just reset
      scopeDataArray = new Float32Array(numberOfSamples * numberOfChannels);
    
      let fakeData;
      if (fakeDataMode) {
        fakeData = new Float32Array(numberOfSamples * numberOfChannels);
        for (let i = 0; i < fakeData.length; i += numberOfChannels) {
          // a noticeably 'polygonal' signal when linearly interpolated
          fakeData[i] = Math.sin(i / 3);
          fakeData[i+1] = Math.cos(i / 3);
        }
      } else {
        fakeData = null;
      }
  
      gl.bindTexture(gl.TEXTURE_2D, scopeDataTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0, // level
        gl.LUMINANCE_ALPHA, // internalformat -- we want numberOfChannels components
        numberOfSamples, // width -- TODO use a squarer texture to hit limits later
        1, // height
        0, // border
        gl.LUMINANCE_ALPHA, // format
        gl.FLOAT, // type
        fakeData);  // pixels -- will be initialized later
      gl.bindTexture(gl.TEXTURE_2D, null);
    
      gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
      const timeIndexes = new Float32Array(numberOfDots);
      for (let i = 0; i < numberOfDots; i++) {
        timeIndexes[i] = (i + 0.5) / numberOfDots;
      }
      gl.bufferData(gl.ARRAY_BUFFER, timeIndexes, gl.STATIC_DRAW);
      
      gl.uniform1f(gl.getUniformLocation(program, 'interpStep'),
        // This is the size of a "one-dot" step in scopeDataTexture's x coordinate (i.e. interpScale * interpStep is one texel) used for implementing interpolation.
        1 / (numberOfSamples * numberOfDots));
    });
    configureDataBuffer.scheduler = scheduler;
    configureDataBuffer();
      
    gltools.handleContextLoss(canvas, config.rebuildMe);
    
    let projectionCell = new DerivedCell(Float32Array, scheduler, dirty => {
      const gainLin = dB(parameters.gain.depend(dirty));
      const tAxisStretch = parameters.history_samples.depend(dirty) / parameters.time_scale.depend(dirty);
      
      const projection = new Float32Array([
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 1
      ])
      let usesTrigger = false;
      String(parameters.axes.depend(dirty)).split(',').forEach((axisSpec, index) => {
        let v0 = 0, v1 = 0, v2 = 0, v3 = 0;
        switch (axisSpec.trim()) {
          case '1': v3 = 1; break;
          case 'ch1': v0 = gainLin; break;
          case 'ch2': v1 = gainLin; break;
          case 't': 
            v2 = index == 2 ? 1 : tAxisStretch;
            if (index != 2) usesTrigger = true;  // TODO kludgy
          break;
          case '1+2': v0 = gainLin; v1 = gainLin; break;
          case '1-2': v0 = gainLin; v1 = -gainLin; break;
          default:
            console.warn('bad axis specification', JSON.stringify(axisSpec));
            break;
        }
        projection[index * 4 + 0] += v0;
        projection[index * 4 + 1] += v1;
        projection[index * 4 + 2] += v2;
        projection[index * 4 + 3] += v3;
      });
      if (false) {
        console.log(projection.slice(0, 4));
        console.log(projection.slice(4, 8));
        console.log(projection.slice(8, 12));
        console.log('---', usesTrigger);
      }
      return {
        projection: projection,
        usesTrigger: usesTrigger
      };
    });
    
    // Assumes gl.useProgram(program).
    const setProjection = (() => {
      const dynamicProjectionBuffer = new Float32Array(4 * 4);
      return function setProjection(staticProjection, aspect, triggerRelativeTime, zOffset) {
        dynamicProjectionBuffer.set(staticProjection);
        // multiply with the trigger translation
        //  TODO use real matrix manipulation functions
        for (let i = 0; i < 4; i++) {
          dynamicProjectionBuffer[i * 4 + 3] -= dynamicProjectionBuffer[i * 4 + 2] * (triggerRelativeTime * 2 - 1);
        }
        // apply aspect ratio -- TODO conditional on axis type
        for (let i = 0; i < 4; i++) {
          dynamicProjectionBuffer[i] /= aspect;
        }
        // apply z offset
        dynamicProjectionBuffer[2 * 4 + 3] += zOffset;
        
        gl.uniformMatrix4fv(gl.getUniformLocation(program, 'projection'), false, dynamicProjectionBuffer);
      }
    })();
    
    const draw = config.boundedFn(function drawImpl() {
      let w, h;
      // Fit current layout
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) {
        // implicitly clears
        canvas.width = w;
        canvas.height = h;
        postProcessor1.setSize(w, h);
        postProcessor2.setSize(w, h);
      }
      // TODO better viewport / axis scaling rule
      // TODO: use drawingBufferWidth etc.
      const aspect = w / h;
      gl.viewport(0, 0, w, h);

      let ppKernel;
      {
        const focus_falloff = parameters.focus_falloff.depend(draw);
        const diameter = kernelRadius * 2 + 1;
        ppKernel = new Float32Array(diameter);
        let sum = 0;
        for (let kx = 0; kx < diameter; kx++) {
          const r = Math.abs(kx - kernelRadius);
          sum += (ppKernel[kx] = Math.exp(-focus_falloff * r * r));
        }
        // normalize kernel
        for (let kx = 0; kx < diameter; kx++) {
          ppKernel[kx] /= sum;
        }
      }
      
      gl.useProgram(postProcessor1.getProgram());
      gl.uniform1fv(gl.getUniformLocation(postProcessor1.getProgram(), 'kernel'), ppKernel);
      
      gl.useProgram(postProcessor2.getProgram());
      gl.uniform1fv(gl.getUniformLocation(postProcessor2.getProgram(), 'kernel'), ppKernel);
      gl.uniform1f(gl.getUniformLocation(postProcessor2.getProgram(), 'intensity'), parameters.intensity.depend(draw));
      gl.uniform1f(gl.getUniformLocation(postProcessor2.getProgram(), 'invgamma'), parameters.invgamma.depend(draw));
      
      gl.useProgram(program);
      gl.uniform1f(gl.getUniformLocation(program, 'persistence_gamma'), parameters.persistence_gamma.depend(draw));
      gl.uniform1f(gl.getUniformLocation(program, 'bufferCutPoint'), circularBufferPtr / numberOfSamples);
      
      // Begin frame and set up attributes for drawing sample points.
      postProcessor1.beginInput();
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enableVertexAttribArray(att_relativeTime);
      gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
      gl.vertexAttribPointer(
        att_relativeTime,
        1, // components
        gl.FLOAT,
        false,
        0,
        0);
      gl.bindTexture(gl.TEXTURE_2D, scopeDataTexture);
      
      const staticProjectionInfo = projectionCell.depend(draw);
      const primitive = parameters.draw_line.depend(draw) ? gl.LINE_STRIP : gl.POINTS;
      let hadAnyTrigger = false;
      if (staticProjectionInfo.usesTrigger) {
        for (let i = triggerSampleIndexes.length - 1; i >= 0; i--) {
          const index = triggerSampleIndexes[mod(triggerAddPtr + i, triggerSampleIndexes.length)];
          if (index != NO_TRIGGER) {
            const relativeTime = mod((index - circularBufferPtr) / numberOfSamples, 1);
            setProjection(staticProjectionInfo.projection, aspect, relativeTime, i / triggerSampleIndexes.length - 1);
            // TODO: Only draw a suitable surrounding range of points.
            gl.drawArrays(primitive, 0, numberOfDots);
            hadAnyTrigger = true;
          }
        }
      }
      if (!hadAnyTrigger) {
        setProjection(staticProjectionInfo.projection, aspect, 0.5, 0.0);
        gl.drawArrays(primitive, 0, numberOfDots);
      }
      
      // End sample point drawing.
      gl.bindTexture(gl.TEXTURE_2D, null);
      postProcessor1.endInput();
      
      postProcessor2.beginInput();
        gl.clear(gl.COLOR_BUFFER_BIT);
        postProcessor1.drawOutput();
      postProcessor2.endInput();
      
      postProcessor2.drawOutput();
    });
    draw.scheduler = config.scheduler;
    
    function contiguousWrite(array) {
      const samples = array.length / numberOfChannels;
      gl.texSubImage2D(
          gl.TEXTURE_2D,
          0, // level
          circularBufferPtr, // xoffset
          0, // yoffset
          samples,  // width
          1,  // height
          gl.LUMINANCE_ALPHA,
          gl.FLOAT,
          array);
      scopeDataArray.set(array, circularBufferPtr * numberOfChannels);
      circularBufferPtr = mod(circularBufferPtr + samples, numberOfSamples);
    }
    
    function newScopeFrame(bundle) {
      if (fakeDataMode || parameters.paused.get()) {
        return;
      }
      
      const newDataArray = bundle[1];
      if (newDataArray.length % numberOfChannels !== 0) {
        // We expect paired IQ/XY samples.
        console.error('Scope data not of even length!');
        return;
      }
      
      // Save range of new data for trigger calculations
      const newDataStart = circularBufferPtr;
      const newDataSampleCount = newDataArray.length / numberOfChannels;
      const newDataEnd = circularBufferPtr + newDataSampleCount;
      
      // Write new data into scopeDataTexture and scopeDataArray.
      gl.bindTexture(gl.TEXTURE_2D, scopeDataTexture);
      const remainingSpace = numberOfSamples * numberOfChannels - circularBufferPtr;
      if (newDataSampleCount > numberOfSamples) {
        // chunk is bigger than our circular buffer, so we must drop some
        circularBufferPtr = 0;
        contiguousWrite(newDataArray.subarray(0, numberOfSamples));
      } else if (remainingSpace < newDataArray.length) {
        // write to end and loop back to beginning
        contiguousWrite(newDataArray.subarray(0, remainingSpace));
        //if (circularBufferPtr != 0) { throw new Error('oops'); }
        contiguousWrite(newDataArray.subarray(remainingSpace));
      } else {
        contiguousWrite(newDataArray);
      }
      gl.bindTexture(gl.TEXTURE_2D, null);
      
      let nadd = 0;
      let nrem = 0;
      
      // Erase trigger indexes pointing into old samples we are about to overwrite
      for (let i = 0; i < triggerSampleIndexes.length; i++) {
        const tsi = triggerSampleIndexes[i];
        if (tsi != NO_TRIGGER && mod(tsi - newDataStart, numberOfSamples) + newDataStart < newDataEnd) {
          triggerSampleIndexes[i] = NO_TRIGGER;
          nrem++;
        }
      }
      
      // calculate new trigger points
      const triggerLevel = 0;  // TODO parameter
      for (let i = newDataStart; i < newDataEnd; i++) {  // note: i may > numberOfSamples
        if (triggerInhibition > 0) {
          triggerInhibition--;
        } else {
          triggerInhibition = 0;
          if (scopeDataArray[mod(i - 1, numberOfSamples) * numberOfChannels] <= triggerLevel
              && scopeDataArray[mod(i, numberOfSamples) * numberOfChannels] > triggerLevel) {
            triggerSampleIndexes[triggerAddPtr] = mod(i, numberOfSamples);
            triggerAddPtr = mod(triggerAddPtr + 1, triggerSampleIndexes.length);
            triggerInhibition += Math.min(numberOfSamples, parameters.time_scale.get());
            nadd++;
          }
        }
      }
      //if (nadd > 0 || nrem > 0) console.log(nadd, nrem);
      
      draw.scheduler.enqueue(draw);
    }
    newScopeFrame.scheduler = config.scheduler;

    scopeCell.subscribe(newScopeFrame);
    draw();
  }
  exports.ScopePlot = ScopePlot;
  
  function ScopeControls(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      const container = getAppend();
      function makeContainer(title) {
        var header = container.appendChild(document.createElement('div'));
        header.className = 'panel frame-controls';
        header.appendChild(document.createTextNode(title));
        const subcontainer = container.appendChild(document.createElement('div'));
        subcontainer.className = 'panel frame';
        setInsertion(subcontainer);
      }
      
      // TODO: Consider breaking up the parameters object itself up instead of hardcoding these groupings. Unclear whether that makes sense or not.
      
      makeContainer('View');
      addWidget('axes', Radio);
      
      makeContainer('Signal');
      addWidget('gain');
      
      makeContainer('Time');
      addWidget('history_samples');
      addWidget('time_scale');

      makeContainer('Rendering');
      addWidget('intensity');
      addWidget('focus_falloff');
      addWidget('persistence_gamma');
      addWidget('invgamma');
      addWidget('draw_line');
      
      setInsertion(container);
    });
  }
  exports.ScopeControls = ScopeControls;
  
  return Object.freeze(exports);
});