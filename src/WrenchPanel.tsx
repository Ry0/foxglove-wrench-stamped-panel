import { PanelExtensionContext, Topic, MessageEvent, SettingsTreeAction } from "@foxglove/extension";
import { useLayoutEffect, useEffect, useState, useMemo, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { produce } from "immer";
import { set } from "lodash";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// Header definition for stamped messages
interface Header {
  frame_id: string;
  stamp: { sec: number; nsec: number };
}

// Vector3 type definition
interface Vector3 {
  x: number;
  y: number;
  z: number;
}

// WrenchStamped message type definition
interface WrenchStampedMessage {
  header: Header;
  wrench: {
    force: Vector3;
    torque: Vector3;
  };
}

// TF message type definition
interface Transform {
  translation: Vector3;
  rotation: {
    x: number;
    y: number;
    z: number;
    w: number;
  };
}

interface TransformStamped {
  header: Header;
  child_frame_id: string;
  transform: Transform;
}

interface TFMessage {
  transforms: TransformStamped[];
}

// Message event types
type WrenchStampedMessageEvent = MessageEvent<WrenchStampedMessage>;
type TFMessageEvent = MessageEvent<TFMessage>;

// TF Tree structure for frame transformation
interface TFTreeNode {
  frame_id: string;
  parent_frame_id?: string;
  transform: Transform;
  timestamp: number; // For freshness check
}

// Panel state definition
type PanelState = {
  data: {
    label: string;
    topic?: string;
    visible: boolean;
    fixedFrame: string;
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
  const [message, setMessage] = useState<WrenchStampedMessageEvent>();
  // const [tfMessages, setTfMessages] = useState<TFMessageEvent[]>([]);
  const [sensorFrameId, setSensorFrameId] = useState<string>("");
  const [tfTree, setTfTree] = useState<Map<string, TFTreeNode>>(new Map());
  const [renderDone, setRenderDone] = useState<(() => void) | undefined>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const forceArrowRef = useRef<THREE.ArrowHelper | null>(null);
  const torqueArrowRef = useRef<THREE.ArrowHelper | null>(null);
  const sensorGroupRef = useRef<THREE.Group | null>(null);
  const torqueRotationIndicatorRef = useRef<THREE.Group | null>(null);
  const animationFrameRef = useRef<number>(0);

  // Restore state from layout
  const [state, setState] = useState<PanelState>(() => {
    const initialState = context.initialState as Partial<PanelState>;
    return { 
      data: {
        label: initialState?.data?.label ?? "Wrench Visualization",
        topic: initialState?.data?.topic,
        visible: initialState?.data?.visible ?? true,
        fixedFrame: initialState?.data?.fixedFrame ?? "world",
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

  // Filter topics for WrenchStamped message type only
  const wrenchStampedTopics = useMemo(
    () => (topics ?? []).filter((topic) =>
      topic.schemaName === "geometry_msgs/msg/WrenchStamped" ||
      topic.schemaName === "geometry_msgs/WrenchStamped"
    ),
    [topics],
  );

  // Filter topics for TF message types
  const tfTopics = useMemo(
    () => (topics ?? []).filter((topic) =>
      topic.schemaName === "tf2_msgs/msg/TFMessage" || 
      topic.schemaName === "tf2_msgs/TFMessage" ||
      topic.schemaName === "tf/tfMessage"
    ),
    [topics],
  );

  // Extract available frames from TF messages
  const availableFrames = useMemo(() => {
    const frames = new Set<string>();
    frames.add(state.data.fixedFrame); // Add fixed frame

    // Add frames from TF tree
    tfTree.forEach((node) => {
      frames.add(node.frame_id);
      if (node.parent_frame_id) {
        frames.add(node.parent_frame_id);
      }
    });

    // Add sensor frame if available
    if (sensorFrameId) {
      frames.add(sensorFrameId);
    }

    return Array.from(frames).sort();
  }, [tfTree, state.data.fixedFrame, sensorFrameId]);

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

  // Helper function to update TF tree with new transform information
  const updateTFTree = useCallback((newTfMessages: TFMessageEvent[]) => {
    setTfTree(prevTree => {
      const newTree = new Map(prevTree);
      
      newTfMessages.forEach(tfMsg => {
        tfMsg.message.transforms.forEach(transform => {
          const parentFrame = transform.header.frame_id;
          const childFrame = transform.child_frame_id;
          const timestamp = transform.header.stamp.sec * 1e9 + transform.header.stamp.nsec;

          // Add or update child frame node
          newTree.set(childFrame, {
            frame_id: childFrame,
            parent_frame_id: parentFrame,
            transform: transform.transform,
            timestamp
          });
          
          // Ensure parent frame exists (might not have a parent itself yet)
          if (!newTree.has(parentFrame)) {
            newTree.set(parentFrame, {
              frame_id: parentFrame,
              transform: { 
                translation: { x: 0, y: 0, z: 0 }, 
                rotation: { x: 0, y: 0, z: 0, w: 1 } 
              },
              timestamp
            });
          }
        });
      });
      
      return newTree;
    });
  }, []);

  // Find transform path between two frames
  const findTransformPath = useCallback((sourceFrame: string, targetFrame: string): string[] => {
    if (sourceFrame === targetFrame) {
      return [sourceFrame];
    }
    
    // Simple BFS to find path
    const visited = new Set<string>();
    const queue: { frame: string; path: string[] }[] = [{ frame: sourceFrame, path: [sourceFrame] }];
    
    while (queue.length > 0) {
      const { frame, path } = queue.shift()!;
      
      if (frame === targetFrame) {
        return path;
      }
      
      if (visited.has(frame)) {
        continue;
      }
      
      visited.add(frame);
      
      // Find all connected frames (children and parents)
      tfTree.forEach((node, nodeFrameId) => {
        // Check if this node is a child of current frame
        if (node.parent_frame_id === frame && !visited.has(nodeFrameId)) {
          queue.push({ frame: nodeFrameId, path: [...path, nodeFrameId] });
        }
        
        // Check if this node is a parent of current frame
        if (nodeFrameId === node.parent_frame_id && node.frame_id === frame && !visited.has(nodeFrameId)) {
          queue.push({ frame: nodeFrameId, path: [...path, nodeFrameId] });
        }
      });
    }
    
    return []; // No path found
  }, [tfTree]);

  // Compute transform between two frames by walking the transform tree
  const computeTransform = useCallback((sourceFrame: string, targetFrame: string): Transform | null => {
    if (sourceFrame === targetFrame) {
      return {
        translation: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 }
      };
    }
    
    // Find path between frames
    const path = findTransformPath(sourceFrame, targetFrame);
    
    if (path.length < 2) {
      return null; // No path found
    }
    
    // Initialize with identity transform
    let resultTransform = new THREE.Matrix4().identity();
    
    // Walk through the path applying transforms
    for (let i = 0; i < path.length - 1; i++) {
      const fromFrame = path[i];
      const toFrame = path[i + 1];
      
      // Get the transform
      let transform: Transform | null = null;
      let inverse = false;
      
      // Check direct transform
      const toNode = tfTree.get(toFrame!);
      if (toNode && toNode.parent_frame_id === fromFrame) {
        transform = toNode.transform;
        inverse = false;
      } else {
        // Check inverse transform
        const fromNode = tfTree.get(fromFrame!);
        if (fromNode && fromNode.parent_frame_id === toFrame) {
          transform = fromNode.transform;
          inverse = true;
        }
      }
      
      if (!transform) {
        return null; // Missing transform in path
      }
      
      // Convert to THREE.js objects
      const translation = new THREE.Vector3(
        transform.translation.x,
        transform.translation.y,
        transform.translation.z
      );
      const rotation = new THREE.Quaternion(
        transform.rotation.x,
        transform.rotation.y,
        transform.rotation.z,
        transform.rotation.w
      );
      
      // Create transform matrix
      const mat = new THREE.Matrix4().compose(
        translation,
        rotation,
        new THREE.Vector3(1, 1, 1)
      );
      
      // Apply inverse if needed
      if (inverse) {
        mat.invert();
      }
      
      // Multiply into result
      resultTransform.multiply(mat);
    }
    
    // Extract final translation and rotation
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    
    resultTransform.decompose(position, quaternion, scale);
    
    return {
      translation: { x: position.x, y: position.y, z: position.z },
      rotation: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
    };
  }, [tfTree, findTransformPath]);

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
    gridHelper.rotation.x = Math.PI / 2; // X軸まわりに90度回転
    gridHelper.visible = state.display.gridVisible;
    scene.add(gridHelper);

    // Add axes
    const axesHelper = new THREE.AxesHelper(1);
    axesHelper.visible = state.display.axesVisible;
    scene.add(axesHelper);

    // Create sensor group
    const sensorGroup = new THREE.Group();
    scene.add(sensorGroup);
    sensorGroupRef.current = sensorGroup;

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
    sensorGroup.add(forceArrow);
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
    sensorGroup.add(torqueArrow);
    torqueArrowRef.current = torqueArrow;

    const torqueRotationIndicator = createTorqueRotationIndicator(
      new THREE.Vector3(0, 1, 0),
      state.display.torqueScaleFactor,
      0.5, // 半径
      parseInt(state.display.torqueColor.substring(1), 16)
    );
    torqueRotationIndicator.visible = state.display.showTorque;
    sensorGroup.add(torqueRotationIndicator);
    torqueRotationIndicatorRef.current = torqueRotationIndicator;

    // Add a small coordinate axes at sensor position
    const sensorAxes = new THREE.AxesHelper(0.3);
    sensorGroup.add(sensorAxes);

    // Animation loop
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      if (controlsRef.current) {
        controlsRef.current.update();
      }
      if (rendererRef.current && sceneRef.current && cameraRef.current) {
        rendererRef.current.render(sceneRef.current, cameraRef.current);
      }
    };
    animate();
  }, [state.display.gridVisible, state.display.axesVisible, state.display.showForce, state.display.showTorque, state.display.forceColor, state.display.torqueColor]);

  // Update sensor position based on TF data
  const updateSensorPosition = useCallback(() => {
    if (!sensorGroupRef.current || !sensorFrameId || sensorFrameId === state.data.fixedFrame) {
      return;
    }

    const transform = computeTransform(state.data.fixedFrame, sensorFrameId);
    if (transform) {
      const { translation, rotation } = transform;
      
      // Update position
      sensorGroupRef.current.position.set(translation.x, translation.y, translation.z);
      
      // Update rotation
      const quaternion = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
      sensorGroupRef.current.quaternion.copy(quaternion);
    }
  }, [sensorFrameId, state.data.fixedFrame, computeTransform]);

  // Update arrows based on message
  const updateArrows = useCallback(() => {
    if (!forceArrowRef.current || !torqueArrowRef.current || !torqueRotationIndicatorRef.current || !message) return;

    const { force, torque } = message.message.wrench;
    
    // Update force arrow
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
    
    // Update torque arrow
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
      
      // 追加: トルク回転インジケーターを更新
      // 古いインジケーターを削除
      if (torqueRotationIndicatorRef.current.parent) {
        torqueRotationIndicatorRef.current.parent.remove(torqueRotationIndicatorRef.current);
      }
      
      // 新しいインジケーターを作成
      const radius = torqueLength * state.display.torqueScaleFactor * 0.15;
      const newIndicator = createTorqueRotationIndicator(
        torqueVector,
        torqueLength * state.display.torqueScaleFactor,
        radius,
        parseInt(state.display.torqueColor.substring(1), 16)
      );
      newIndicator.visible = state.display.showTorque;
      sensorGroupRef.current?.add(newIndicator);
      torqueRotationIndicatorRef.current = newIndicator;
    }
    torqueArrowRef.current.visible = state.display.showTorque;
    torqueRotationIndicatorRef.current.visible = state.display.showTorque;
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

    const topicOptions = wrenchStampedTopics.map((topic) => ({ value: topic.name, label: topic.name }));
    const frameOptions = availableFrames.map((frame) => ({ value: frame, label: frame }));

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
            fixedFrame: {
              label: "Fixed Frame",
              input: "select",
              options: frameOptions,
              value: state.data.fixedFrame,
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
  }, [context, actionHandler, state, wrenchStampedTopics, availableFrames]);

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

  // Update sensor position when TF data or sensor frame changes
  useEffect(() => {
    updateSensorPosition();
  }, [updateSensorPosition]);

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

  // Subscribe to topics
  useEffect(() => {
    const subscriptions = [];
    
    // Subscribe to wrench topic if selected
    if (state.data.topic) {
      subscriptions.push({ topic: state.data.topic });
    }
    
    // Subscribe to TF topics
    tfTopics.forEach(topic => {
      subscriptions.push({ topic: topic.name });
    });
    
    if (subscriptions.length > 0) {
      context.subscribe(subscriptions);
    }
  }, [context, state.data.topic, tfTopics]);

  // Select default topic
  useEffect(() => {
    if (state.data.topic === undefined && wrenchStampedTopics.length > 0) {
      setState(produce((draft) => {
        draft.data.topic = wrenchStampedTopics[0]?.name;
      }));
    }
  }, [state.data.topic, wrenchStampedTopics]);

  // Setup render callback
  useLayoutEffect(() => {
    context.onRender = (renderState, done) => {
      setRenderDone(() => done);
      setTopics(renderState.topics);

      if (renderState.currentFrame && renderState.currentFrame.length > 0) {
        // Process frame messages
        const newTfMessages: TFMessageEvent[] = [];
        
        renderState.currentFrame.forEach(frameMsg => {
          const topic = frameMsg.topic;
          
          // Process TF messages
          if (tfTopics.some(t => t.name === topic)) {
            newTfMessages.push(frameMsg as TFMessageEvent);
          }
          
          // Process WrenchStamped message for the selected topic
          if (topic === state.data.topic) {
            const wrenchMsg = frameMsg as WrenchStampedMessageEvent;
            setMessage(wrenchMsg);
            setSensorFrameId(wrenchMsg.message.header.frame_id);
          }
        });
        
        if (newTfMessages.length > 0) {
          updateTFTree(newTfMessages);
          // setTfMessages(newTfMessages);
        }
      }
    };

    context.watch("topics");
    context.watch("currentFrame");
  }, [context, state.data.topic, tfTopics, updateTFTree]);

  // Call render done function
  useEffect(() => {
    renderDone?.();
  }, [renderDone]);

  // Helper to render force/torque data
  const renderWrenchData = () => {
    if (!message) return null;
    
    const { force, torque } = message.message.wrench;
    const frameId = message.message.header.frame_id;
    
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "8px", fontSize: "12px", marginTop: "8px" }}>
        <div>
          <strong>Frame ID:</strong> {frameId}
        </div>
        <div style={{ display: "flex", gap: "16px" }}>
          <div>
            <strong>Force:</strong>{" "}
            ({force.x.toFixed(3)}, {force.y.toFixed(3)}, {force.z.toFixed(3)})
          </div>
          <div>
            <strong>Torque:</strong>{" "}
            ({torque.x.toFixed(3)}, {torque.y.toFixed(3)}, {torque.z.toFixed(3)})
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "1rem", borderBottom: "1px solid #333" }}>
        <h2 style={{ margin: 0 }}>{state.data.topic ?? "Select a WrenchStamped topic in settings"}</h2>
        {renderWrenchData()}
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

function createTorqueRotationIndicator(direction:any, distance:any, radius:any, color:any) {
  const group = new THREE.Group();
  
  // Normalize the direction vector
  const normalizedDir = new THREE.Vector3().copy(direction).normalize();
  
  // Create a torus (circular arc) to show rotation direction
  const arcAngle = Math.PI * 1.5; // 270 degrees
  const torusGeometry = new THREE.TorusGeometry(radius, radius * 0.05, 8, 24, arcAngle);
  const torusMaterial = new THREE.MeshBasicMaterial({ color });
  const torus = new THREE.Mesh(torusGeometry, torusMaterial);
  
  // Create a base group for positioning the entire indicator along the direction vector
  const positionedGroup = new THREE.Group();
  
  // Orient the torus to align with the direction vector
  const normalAxis = new THREE.Vector3(0, 0, 1);
  const rotationAxis = new THREE.Vector3().crossVectors(normalAxis, normalizedDir);
  
  if (rotationAxis.length() > 0.001) {
    // If direction isn't aligned with Z-axis
    const angle = normalAxis.angleTo(normalizedDir);
    torus.quaternion.setFromAxisAngle(rotationAxis.normalize(), angle);
  }
  
  positionedGroup.add(torus);
  
  // Calculate the end point of the torus arc
  const endAngle = -Math.PI/2; // End angle of the arc
  
  // Create arrow head to show rotation direction
  const arrowHeadGeometry = new THREE.ConeGeometry(radius * 0.15, radius * 0.3, 8);
  const arrowHeadMaterial = new THREE.MeshBasicMaterial({ color });
  const arrowHead = new THREE.Mesh(arrowHeadGeometry, arrowHeadMaterial);
  
  // Position the arrow at the end of the torus arc
  arrowHead.position.set(
    radius * Math.cos(endAngle),
    radius * Math.sin(endAngle),
    0
  );
  
  // Orient the arrow head tangent to the torus at the end point
  const tangentAngle = endAngle + Math.PI/2;
  const tangentDir = new THREE.Vector3(
    Math.cos(tangentAngle),
    Math.sin(tangentAngle),
    0
  );
  
  // Create a temporary vector to represent the default cone direction
  const arrowDir = new THREE.Vector3(0, 1, 0);
  
  // Set quaternion to rotate from default direction to tangent direction
  arrowHead.quaternion.setFromUnitVectors(arrowDir, tangentDir);
  
  // Move the cone back a bit so its base aligns with the torus end
  const coneBaseOffset = radius * 0.15; // Adjust based on cone dimensions
  arrowHead.position.x -= tangentDir.x * coneBaseOffset;
  arrowHead.position.y -= tangentDir.y * coneBaseOffset;
  
  // Add the arrow to the positioned group and copy the torus rotation
  const arrowGroup = new THREE.Group();
  arrowGroup.add(arrowHead);
  arrowGroup.quaternion.copy(torus.quaternion);
  positionedGroup.add(arrowGroup);
  
  // Move the entire indicator along the direction vector
  // Position it at a distance from the origin in the direction vector
  // const offsetDistance = radius * 0.5; // Adjust this value as needed
  const offsetDistance = distance * 0.25;
  const offsetPosition = new THREE.Vector3()
    .copy(normalizedDir)
    .multiplyScalar(offsetDistance);
  
  positionedGroup.position.copy(offsetPosition);
  
  // Add the positioned group to the main group
  group.add(positionedGroup);
  
  return group;
}