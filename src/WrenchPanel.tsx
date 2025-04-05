import { PanelExtensionContext, Topic, MessageEvent, SettingsTreeAction } from "@foxglove/extension";
import { useLayoutEffect, useEffect, useState, useMemo, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { produce } from "immer";
import { set } from "lodash";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

// Wrench message type definition
interface Vector3 {
  x: number;
  y: number;
  z: number;
}

interface WrenchMessage {
  force: Vector3;
  torque: Vector3;
}

type WrenchMessageEvent = MessageEvent<WrenchMessage>;

// Panel state definition
type PanelState = {
  data: {
    label: string;
    topic?: string;
    visible: boolean;
  };
  display: {
    showForce: boolean;
    showTorque: boolean;
    forceScaleFactor: number;
    torqueScaleFactor: number;
    forceColor: string;
    torqueColor: string;
    gridVisible: boolean;
    axesVisible: boolean;
  };
};

function WrenchPanel({ context }: { context: PanelExtensionContext }): JSX.Element {
  const [topics, setTopics] = useState<readonly Topic[] | undefined>();
  const [message, setMessage] = useState<WrenchMessageEvent>();
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const forceArrowRef = useRef<THREE.ArrowHelper | null>(null);
  const torqueArrowRef = useRef<THREE.ArrowHelper | null>(null);
  const animationFrameRef = useRef<number>(0);

  // Restore state from layout
  const [state, setState] = useState<PanelState>(() => {
    const initialState = context.initialState as Partial<PanelState>;
    return { 
      data: {
        label: initialState?.data?.label ?? "Wrench Visualization",
        topic: initialState?.data?.topic,
        visible: initialState?.data?.visible ?? true,
      },
      display: {
        showForce: initialState?.display?.showForce ?? true,
        showTorque: initialState?.display?.showTorque ?? true,
        forceScaleFactor: initialState?.display?.forceScaleFactor ?? 1.0,
        torqueScaleFactor: initialState?.display?.torqueScaleFactor ?? 1.0,
        forceColor: initialState?.display?.forceColor ?? "#ff0000",
        torqueColor: initialState?.display?.torqueColor ?? "#0000ff",
        gridVisible: initialState?.display?.gridVisible ?? true,
        axesVisible: initialState?.display?.axesVisible ?? true,
      }
    };
  });

  // Filter topics for Wrench message type
  const wrenchTopics = useMemo(
    () => (topics ?? []).filter((topic) =>
      topic.schemaName === "geometry_msgs/msg/Wrench" || 
      topic.schemaName === "geometry_msgs/Wrench"
    ),
    [topics],
  );

  // Handle settings actions
  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action === "update") {
        const { path, value } = action.payload;
        setState(produce((draft) => set(draft, path, value)));

        // Update subscription if topic changed
        if (path[1] === "topic") {
          context.subscribe([{ topic: value as string }]);
        }
      }
    },
    [context],
  );

  // Setup Three.js scene
  const setupScene = useCallback(() => {
    if (!canvasRef.current) return;

    // Create renderer
    const renderer = new THREE.WebGLRenderer({
      canvas: canvasRef.current,
      antialias: true,
      alpha: true,
    });
    renderer.setSize(canvasRef.current.clientWidth, canvasRef.current.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    rendererRef.current = renderer;

    // Create scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121217);
    sceneRef.current = scene;

    // Create camera
    const camera = new THREE.PerspectiveCamera(
      75,
      canvasRef.current.clientWidth / canvasRef.current.clientHeight,
      0.1,
      1000
    );
    camera.position.set(2, 2, 2);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    // Add controls
    const controls = new OrbitControls(camera, canvasRef.current);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;
    controlsRef.current = controls;

    // Add grid
    const gridHelper = new THREE.GridHelper(10, 10);
    gridHelper.visible = state.display.gridVisible;
    scene.add(gridHelper);

    // Add axes
    const axesHelper = new THREE.AxesHelper(1);
    axesHelper.visible = state.display.axesVisible;
    scene.add(axesHelper);

    // Create force arrow (initial)
    const forceArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 0),
      1,
      parseInt(state.display.forceColor.substring(1), 16),
      0.2,
      0.1
    );
    forceArrow.visible = state.display.showForce;
    scene.add(forceArrow);
    forceArrowRef.current = forceArrow;

    // Create torque arrow (initial)
    const torqueArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(0, 0, 0),
      1,
      parseInt(state.display.torqueColor.substring(1), 16),
      0.2,
      0.1
    );
    torqueArrow.visible = state.display.showTorque;
    scene.add(torqueArrow);
    torqueArrowRef.current = torqueArrow;

    // Animation loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
  }, [state.display.gridVisible, state.display.axesVisible, state.display.showForce, state.display.showTorque, state.display.forceColor, state.display.torqueColor]);

  // Update arrows based on message
  const updateArrows = useCallback(() => {
    if (!sceneRef.current || !message) return;

    const { force, torque } = message.message;
    
    // Update force arrow
    if (forceArrowRef.current) {
      const forceVector = new THREE.Vector3(force.x, force.y, force.z);
      const forceLength = forceVector.length();
      if (forceLength > 0) {
        forceVector.normalize();
        forceArrowRef.current.setDirection(forceVector);
        forceArrowRef.current.setLength(
          forceLength * state.display.forceScaleFactor,
          forceLength * state.display.forceScaleFactor * 0.2,
          forceLength * state.display.forceScaleFactor * 0.1
        );
      }
      forceArrowRef.current.visible = state.display.showForce;
    }

    // Update torque arrow
    if (torqueArrowRef.current) {
      const torqueVector = new THREE.Vector3(torque.x, torque.y, torque.z);
      const torqueLength = torqueVector.length();
      if (torqueLength > 0) {
        torqueVector.normalize();
        torqueArrowRef.current.setDirection(torqueVector);
        torqueArrowRef.current.setLength(
          torqueLength * state.display.torqueScaleFactor,
          torqueLength * state.display.torqueScaleFactor * 0.2,
          torqueLength * state.display.torqueScaleFactor * 0.1
        );
      }
      torqueArrowRef.current.visible = state.display.showTorque;
    }
  }, [message, state.display.showForce, state.display.showTorque, state.display.forceScaleFactor, state.display.torqueScaleFactor]);

  // Resize handler
  const handleResize = useCallback(() => {
    if (!canvasRef.current || !rendererRef.current || !cameraRef.current) return;
    
    const width = canvasRef.current.clientWidth;
    const height = canvasRef.current.clientHeight;
    
    cameraRef.current.aspect = width / height;
    cameraRef.current.updateProjectionMatrix();
    rendererRef.current.setSize(width, height);
  }, []);

  // Update settings editor
  useEffect(() => {
    context.saveState(state);

    const topicOptions = wrenchTopics.map((topic) => ({ value: topic.name, label: topic.name }));

    context.updatePanelSettingsEditor({
      actionHandler,
      nodes: {
        data: {
          label: state.data.label,
          renamable: true,
          visible: state.data.visible,
          icon: "Cube",
          fields: {
            topic: {
              label: "Topic",
              input: "select",
              options: topicOptions,
              value: state.data.topic,
            },
          },
        },
        display: {
          label: "Display",
          icon: "Shapes",
          fields: {
            showForce: {
              label: "Show Force",
              input: "boolean",
              value: state.display.showForce,
            },
            showTorque: {
              label: "Show Torque",
              input: "boolean",
              value: state.display.showTorque,
            },
            forceScaleFactor: {
              label: "Force Scale Factor",
              input: "number",
              min: 0.01,
              max: 10,
              step: 0.1,
              value: state.display.forceScaleFactor,
            },
            torqueScaleFactor: {
              label: "Torque Scale Factor",
              input: "number",
              min: 0.01,
              max: 10,
              step: 0.1,
              value: state.display.torqueScaleFactor,
            },
            forceColor: {
              label: "Force Color",
              input: "rgb",
              value: state.display.forceColor,
            },
            torqueColor: {
              label: "Torque Color",
              input: "rgb",
              value: state.display.torqueColor,
            },
            gridVisible: {
              label: "Show Grid",
              input: "boolean",
              value: state.display.gridVisible,
            },
            axesVisible: {
              label: "Show Axes",
              input: "boolean",
              value: state.display.axesVisible,
            },
          },
        },
      },
    });
  }, [context, actionHandler, state, wrenchTopics]);

  // Initialize Three.js
  useEffect(() => {
    setupScene();
    window.addEventListener("resize", handleResize);
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      window.removeEventListener("resize", handleResize);
      if (rendererRef.current) {
        rendererRef.current.dispose();
      }
    };
  }, [setupScene, handleResize]);

  // Update visualization when message or settings change
  useEffect(() => {
    updateArrows();
  }, [updateArrows]);

  // Update grid and axes visibility
  useEffect(() => {
    if (!sceneRef.current) return;

    sceneRef.current.children.forEach((child) => {
      if (child instanceof THREE.GridHelper) {
        child.visible = state.display.gridVisible;
      }
      if (child instanceof THREE.AxesHelper) {
        child.visible = state.display.axesVisible;
      }
    });
  }, [state.display.gridVisible, state.display.axesVisible]);

  // Subscribe to topic
  useEffect(() => {
    if (state.data.topic) {
      context.subscribe([{ topic: state.data.topic }]);
    }
  }, [context, state.data.topic]);

  // Select default topic
  useEffect(() => {
    if (state.data.topic == undefined && wrenchTopics.length > 0) {
      setState(produce((draft) => {
        draft.data.topic = wrenchTopics[0]?.name;
      }));
    }
  }, [state.data.topic, wrenchTopics]);

  // Setup render callback
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      if (renderState.currentFrame && renderState.currentFrame.length > 0) {
        setMessage(renderState.currentFrame[renderState.currentFrame.length - 1] as WrenchMessageEvent);
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, [context]);

  // Call render done function
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "1rem", borderBottom: "1px solid #333" }}>
        <h2 style={{ margin: 0 }}>{state.data.topic ?? "Select a Wrench topic in settings"}</h2>
        {message && (
          <div style={{ display: "flex", gap: "16px", fontSize: "12px", marginTop: "8px" }}>
            <div>
              <strong>Force:</strong>{" "}
              ({message.message.force.x.toFixed(3)}, {message.message.force.y.toFixed(3)}, {message.message.force.z.toFixed(3)})
            </div>
            <div>
              <strong>Torque:</strong>{" "}
              ({message.message.torque.x.toFixed(3)}, {message.message.torque.y.toFixed(3)}, {message.message.torque.z.toFixed(3)})
            </div>
          </div>
        )}
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </div>
    </div>
  );
}

export function initExamplePanel(context: PanelExtensionContext): () => void {
  const root = createRoot(context.panelElement);

  root.render(<WrenchPanel context={context} />);

  return () => {
    root.unmount();
  };
}