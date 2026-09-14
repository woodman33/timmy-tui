import { useState, useEffect, useRef } from 'react';
import type { GraphicsPipeline } from '../../graphics/pipeline.js';
import { KittyGraphicsPipeline } from '../../graphics/kitty-pipeline.js';
import { ITerm2Pipeline } from '../../graphics/iterm2-pipeline.js';
import { SixelPipeline } from '../../graphics/sixel-pipeline.js';
import { CompanionPipeline } from '../../graphics/companion-pipeline.js';
import { AnsiPipeline } from '../../graphics/ansi-pipeline.js';
import { selectPipeline } from '../../graphics/capabilities.js';
import { RiveFrameExtractor } from '../../graphics/frame-extractor.js';
import type { GraphicsCapabilities } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export function useGraphicsPipeline(
  capabilities: GraphicsCapabilities | null,
  agentState: 'idle' | 'thinking' | 'streaming' | 'tool_call' | 'error' | 'success',
  graphicsType = 'auto',
  enabled = true
) {
  const [pipeline, setPipeline] = useState<GraphicsPipeline | null>(null);
  const [pipelineType, setPipelineType] = useState<string>('ansi');
  const extractorRef = useRef<RiveFrameExtractor | null>(null);

  useEffect(() => {
    if (!enabled || !capabilities) return;

    const type = graphicsType !== 'auto' ? graphicsType : selectPipeline(capabilities);
    let p: GraphicsPipeline;

    switch (type) {
      case 'kitty':
        p = new KittyGraphicsPipeline();
        break;
      case 'iterm2':
        p = new ITerm2Pipeline();
        break;
      case 'sixel':
        p = new SixelPipeline();
        break;
      case 'companion':
        p = new CompanionPipeline(3001);
        break;
      default:
        p = new AnsiPipeline();
    }

    let extractor: RiveFrameExtractor | null = null;
    let isActive = true;

    p.init().then(async () => {
      if (!isActive) return;
      setPipeline(p);
      setPipelineType(type);

      // Spin up headless Playwright Rive Frame Extractor ONLY if explicitly enabled
      const enablePlaywright = process.env.ENABLE_RIVE_PLAYWRIGHT === 'true';
      if (enablePlaywright && (type === 'kitty' || type === 'iterm2' || type === 'sixel')) {
        try {
          extractor = new RiveFrameExtractor();
          extractorRef.current = extractor;
          await extractor.init('', 400, 300);
          await extractor.setState(agentState);

          // Start the frame generation and pipeline rendering loop
          (async () => {
            for await (const frame of extractor!.frameGenerator(15)) {
              if (!isActive) break;
              p.renderFrame(frame);
            }
          })().catch(err => {
            logger.error('Frame loop error:', err);
          });
        } catch (err) {
          logger.warn('Playwright Rive extraction failed, falling back to TUI rendering:', err);
        }
      }
    }).catch(() => {
      if (!isActive) return;
      // Fallback to ANSI art on initialization failure
      const fallback = new AnsiPipeline();
      fallback.init().then(() => {
        if (!isActive) return;
        setPipeline(fallback);
        setPipelineType('ansi');
      });
    });

    return () => {
      isActive = false;
      p.cleanup();
      if (extractor) {
        extractor.stop().catch(() => {});
      }
      extractorRef.current = null;
    };
  }, [capabilities]);

  // Sync agent state changes dynamically into the Rive state machine inside Playwright!
  useEffect(() => {
    if (pipeline) {
      pipeline.setState(agentState).catch(() => {});
    }
    if (extractorRef.current) {
      extractorRef.current.setState(agentState).catch(() => {});
    }
  }, [agentState, pipeline]);

  return { pipeline, pipelineType };
}
