import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  Node,
  NodeProperties,
  Connection,
  PortCategory,
  PortType,
  PORT_CATEGORIES,
} from './core/base.js';
import { NodeFactory } from './core/nodeSystem.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get the project root directory (two levels up from __dirname)
const projectRoot = path.resolve(__dirname, '..');

// Store created nodes for reference
const nodeInstances = new Map<string, Node>();

// Store created connections
const connections: Connection[] = [];

function createWindow(): void {
  // Construct path relative to the application root
  const iconPath = path.join(app.getAppPath(), 'dist', 'src', 'assets', 'images', 'mascot.png');
  Menu.setApplicationMenu(null);

  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: iconPath, 
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.resolve(projectRoot, 'dist', 'preload-esm.mjs'),
      webSecurity: true,
      sandbox: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    const startUrl = process.env.ELECTRON_START_URL || 'http://localhost:4000/src/builder.html';
    console.log(`Electron is running in development mode, loading from ${startUrl}`);

    let retryCount = 0;
    const maxRetries = 5;
    const retryInterval = 1500;

    const loadApp = () => {
      mainWindow.loadURL(startUrl).catch(err => {
        retryCount++;
        if (retryCount <= maxRetries) {
          console.log(`Connection to dev server failed, retrying (${retryCount}/${maxRetries})...`);
          setTimeout(loadApp, retryInterval);
        } else {
          console.error('Failed to connect to webpack dev server after multiple attempts', err);
          // Fallback to loading from file system
          mainWindow
            .loadFile(path.join(projectRoot, 'dist', 'src', 'builder.html'))
            .catch(e => console.error('Failed to load fallback file:', e));
        }
      });
    };

    loadApp();
    mainWindow.webContents.openDevTools();
  } else {
    console.log('Electron is running in production mode, loading from file');
    mainWindow.loadFile(path.join(projectRoot, 'dist', 'src', 'index.html'));
  }
}

function setupIpcHandlers(): void {
  // Handle node creation requests
  ipcMain.handle(
    'node:create',
    async (
      event,
      { type, id, properties }: { type: string; id: string; properties: NodeProperties }
    ) => {
      try {
        const node = NodeFactory.createNode(type, id, properties);
        nodeInstances.set(id, node);

        return {
          id: node.id,
          type: node.type,
          properties: node.properties,
          inputs: node.inputs.map(input => ({
            id: input.id,
            label: input.label,
            dataType: input.dataType,
          })),
          outputs: node.outputs.map(output => ({
            id: output.id,
            label: output.label,
            dataType: output.dataType,
          })),
        };
      } catch (error) {
        console.error('Error creating node:', error);
        throw new Error(
          `Failed to create node: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Get all available node types
  ipcMain.handle('node:getTypes', async () => {
    return NodeFactory.getNodeTypes();
  });

  // Get all registered node types with metadata
  ipcMain.handle('node:getRegisteredTypes', async () => {
    return NodeFactory.getRegisteredTypes();
  });

  // Get node by ID
  ipcMain.handle('node:getById', async (event, id: string) => {
    const node = nodeInstances.get(id);
    if (!node) {
      throw new Error(`Node not found with id: ${id}`);
    }

    return {
      id: node.id,
      type: node.type,
      properties: node.properties,
      inputs: node.inputs.map(input => ({
        id: input.id,
        label: input.label,
        dataType: input.dataType,
      })),
      outputs: node.outputs.map(output => ({
        id: output.id,
        label: output.label,
        dataType: output.dataType,
      })),
    };
  });


  // Create a connection between nodes
  ipcMain.handle(
    'connection:create',
    async (
      event,
      {
        fromNodeId,
        fromPortId,
        toNodeId,
        toPortId,
      }: {
        fromNodeId: string;
        fromPortId: string;
        toNodeId: string;
        toPortId: string;
      }
    ) => {
      try {
        const sourceNode = nodeInstances.get(fromNodeId);
        const targetNode = nodeInstances.get(toNodeId);

        if (!sourceNode) {
          throw new Error(`Source node not found with id: ${fromNodeId}`);
        }

        if (!targetNode) {
          throw new Error(`Target node not found with id: ${toNodeId}`);
        }

        // Find the source port
        const sourcePort = sourceNode.outputs.find(output => output.id === fromPortId);
        if (!sourcePort) {
          throw new Error(`Output port not found: ${fromPortId}`);
        }

        // Find the target port
        const targetPort = targetNode.inputs.find(input => input.id === toPortId);
        if (!targetPort) {
          throw new Error(`Input port not found: ${toPortId}`);
        }

        // Check if connection types are compatible
        if (!arePortTypesCompatible(sourcePort.dataType, targetPort.dataType)) {
          throw new Error(
            `Incompatible port types: ${sourcePort.dataType} -> ${targetPort.dataType}`
          );
        }

        // Check for existing connections to the input port
        const existingConnectionToPort = connections.find(
          conn => conn.toNodeId === toNodeId && conn.toPortId === toPortId
        );

        if (existingConnectionToPort) {
          // Remove the existing connection
          connections.splice(connections.indexOf(existingConnectionToPort), 1);
        }

        // Create new connection
        const connection = new Connection(fromNodeId, fromPortId, toNodeId, toPortId);
        connections.push(connection);

        // Add connection reference to ports
        sourcePort.connectedTo.push(connection);

        return {
          fromNodeId,
          fromPortId,
          toNodeId,
          toPortId,
        };
      } catch (error) {
        console.error('Error creating connection:', error);
        throw new Error(
          `Failed to create connection: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Delete a connection
  ipcMain.handle(
    'connection:delete',
    async (
      event,
      {
        fromNodeId,
        fromPortId,
        toNodeId,
        toPortId,
      }: {
        fromNodeId: string;
        fromPortId: string;
        toNodeId: string;
        toPortId: string;
      }
    ) => {
      try {
        const connectionIndex = connections.findIndex(
          conn =>
            conn.fromNodeId === fromNodeId &&
            conn.fromPortId === fromPortId &&
            conn.toNodeId === toNodeId &&
            conn.toPortId === toPortId
        );
        if (connectionIndex === -1) {
          throw new Error('Connection not found');
        }

        // Get the connection before removing it
        const connection = connections[connectionIndex];

        // Remove the connection
        connections.splice(connectionIndex, 1);

        // Also remove from port references
        const sourceNode = nodeInstances.get(fromNodeId);
        if (sourceNode) {
          const sourcePort = sourceNode.outputs.find(output => output.id === fromPortId);
          if (sourcePort) {
            const connIndex = sourcePort.connectedTo.findIndex(
              conn =>
                conn.fromNodeId === fromNodeId &&
                conn.fromPortId === fromPortId &&
                conn.toNodeId === toNodeId &&
                conn.toPortId === toPortId
            );

            if (connIndex !== -1) {
              sourcePort.connectedTo.splice(connIndex, 1);
            }
          }
        }

        return { success: true };
      } catch (error) {
        console.error('Error deleting connection:', error);
        throw new Error(
          `Failed to delete connection: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  // Get connections for a node
  ipcMain.handle('connection:getForNode', async (event, nodeId: string) => {
    try {
      const nodeConnections = connections.filter(
        conn => conn.fromNodeId === nodeId || conn.toNodeId === nodeId
      );

      return nodeConnections;
    } catch (error) {
      console.error('Error getting connections:', error);
      throw new Error(
        `Failed to get connections: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });
}

/**
 * Type conversion compatibility mapping
 * Defines which port types can be automatically converted to other types
 */
const PORT_TYPE_COMPATIBILITY: Record<PortType, PortType[]> = {
  [PortType.ANY]: Object.values(PortType).filter(type => type !== PortType.CONTROL) as PortType[],
  [PortType.NUMBER]: [PortType.STRING],
  [PortType.BOOLEAN]: [PortType.STRING],
  [PortType.STRING]: [PortType.NUMBER], // Allow string to number
  [PortType.OBJECT]: [],
  [PortType.ARRAY]: [],
  [PortType.CONTROL]: [],
};

/**
 * Check if two port types are compatible for connection
 */
function arePortTypesCompatible(sourceType: string, targetType: string): boolean {
  const sourceIsFlow = PORT_CATEGORIES[PortCategory.FLOW].includes(sourceType as PortType);
  const targetIsFlow = PORT_CATEGORIES[PortCategory.FLOW].includes(targetType as PortType);

  if (sourceIsFlow !== targetIsFlow) {
    return false;
  }

  if (sourceIsFlow && targetIsFlow) {
    return true;
  }

  // For data ports, check specific type compatibility
  if (sourceType === PortType.ANY || targetType === PortType.ANY) {
    return true;
  }

  // Check direct type match
  if (sourceType === targetType) {
    return true;
  }

  const compatibleTypes = PORT_TYPE_COMPATIBILITY[sourceType as PortType] || [];
  return compatibleTypes.includes(targetType as PortType);
}

app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
