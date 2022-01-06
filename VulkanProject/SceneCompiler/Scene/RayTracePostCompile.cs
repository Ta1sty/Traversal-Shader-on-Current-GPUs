﻿using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using SceneCompiler.Scene.SceneTypes;

namespace SceneCompiler.Scene
{
    public class RayTracePostCompile
    {
        private readonly SceneBuffers _buffers;
        private readonly bool _multiLevel;
        public RayTracePostCompile(SceneBuffers buffers, bool multiLevel)
        {
            _buffers = buffers;
            _multiLevel = multiLevel;
        }

        public void PostCompile()
        {
            if (_multiLevel)
                MultiLevel();
            else
                SingleLevel();
        }

        private void MultiLevel()
        {
            var buffer = _buffers.Nodes;
            SceneNode root = buffer[_buffers.RootNode];
            root.Level = 0;
            DepthRecursion(root);

            List<SceneNode> evenChildren = new();
            List<SceneNode> oddChildren = new();
            List<SceneNode> blasAdd = new();
            List<SceneNode> tlasAdd = new();
            foreach (var node in buffer)
            {
                foreach (var child in node.Children)
                {
                    if (child.Level % 2 == 0)
                    {
                        evenChildren.Add(child);
                    }
                    else
                    {
                        oddChildren.Add(child);
                    }
                }

                if (node.Level % 2 == 0) // TLAS Node - we dont want geometry and even-children
                {
                    if (node.NumTriangles > 0 || evenChildren.Count > 0)
                    {
                        var dummy = new SceneNode
                        {
                            // set new Level and index
                            Level = node.Level+1,
                            Name = "DummyBLAS",
                            // add the geometry
                            IndexBufferIndex = node.IndexBufferIndex,
                            NumTriangles = node.NumTriangles,
                            // add the even children
                            NumChildren = evenChildren.Count,
                            NumEven = (uint)evenChildren.Count,
                            Children = new List<SceneNode>(evenChildren),
                            // set transforms to identity
                            ObjectToWorld = Matrix4x4.Identity,
                            WorldToObject = Matrix4x4.Identity,
                        };
                        // add odd dummy to buffer and to children of the even node
                        blasAdd.Add(dummy);
                        oddChildren.Add(dummy);
                        // removed geometry
                        node.IndexBufferIndex = -1;
                        node.NumTriangles = 0;

                        // add only the odd children
                        node.NumOdd = (uint) oddChildren.Count;
                        node.Children.Clear();
                        node.Children.AddRange(oddChildren);
                        node.NumChildren = oddChildren.Count;
                    }
                    else // only odd geometry
                    {
                        // leave everything, set only the odd count, since even is 0
                        node.NumOdd = (uint)oddChildren.Count;
                    }
                }
                else // BLAS Node we dont want Odd Children 
                {
                    if (oddChildren.Count > 0)
                    {
                        // we solve this by building a new tlas for this reference
                        // but this can happen multiple times for the same blas
                        // so if possible we want to reuse the tlas
                        var dummy = tlasAdd.Where(x =>
                        {
                            foreach (var child in node.Children)
                            {
                                if (!x.Children.Contains(child))
                                    return false;
                            }
                            return true;
                        }).FirstOrDefault();

                        if (dummy == null)
                        {
                            dummy = new SceneNode
                            {
                                // set new Level and index
                                Level = node.Level + 1,
                                Name = "DummyTLAS",
                                // add the odd children
                                NumChildren = oddChildren.Count,
                                NumOdd = (uint)oddChildren.Count,
                                Children = new List<SceneNode>(oddChildren),
                                // set transforms to identity
                                ObjectToWorld = Matrix4x4.Identity,
                                WorldToObject = Matrix4x4.Identity,
                            };
                            tlasAdd.Add(dummy);
                        }

                        // add even dummy to buffer and children of the odd node
                        evenChildren.Add(dummy);

                        // add only the even children
                        node.NumEven = (uint)evenChildren.Count;
                        node.Children.Clear();
                        node.Children.AddRange(evenChildren);
                        node.NumChildren = evenChildren.Count;
                    }
                    else
                    {
                        // we only want and only have even children, therefore set numEven
                        node.NumEven = (uint) evenChildren.Count;
                    }
                }
                evenChildren.Clear();
                oddChildren.Clear();
                /*
                node.NumEven = (uint) evenChildren.Count;
                node.NumOdd = (uint) oddChildren.Count;
                node.Children = new List<SceneNode>();
                node.Children.AddRange(evenChildren);
                node.Children.AddRange(oddChildren);
                evenChildren.Clear();
                oddChildren.Clear();
                */
            }

            buffer.AddRange(tlasAdd);
            buffer.AddRange(blasAdd);

            for (var i = 0; i < buffer.Count; i++)
            {
                buffer[i].Index = i;
            }
        }

        public void Validate()
        {
            foreach (var node in _buffers.Nodes)
            {
                if (node.Level < 0)
                    throw new Exception("Level was not set");
                foreach (var child in node.Children)
                {
                    if (child.Level <= node.Level)
                        throw new Exception("Child level must always be at least one higher than parent");
                    if (child.Level + node.Level % 2 == 0)
                        throw new Exception("Either two odd levels or two even levels are parent and child");
                    if (child.NumChildren != child.NumEven + child.NumOdd)
                        throw new Exception("Num odd and num even don't add up to numChildren");
                }

                if (node.Index < 0)
                    throw new Exception("Index was not set");
                if (node.Index != _buffers.Nodes.IndexOf(node))
                    throw new Exception("Index doesn't match actual index");
                if (node.Level % 2 == 0 && node.NumTriangles > 0)
                    throw new Exception("Even node references Geometry");
                if (node.NumChildren == 0 && node.NumTriangles == 0)
                    throw new Exception("Node doesn't reference anything");
                if (node.Children.Count != node.NumChildren)
                    throw new Exception("Node NumChildren count differs from actual count");
                if (node.NumTriangles > 0 && node.IndexBufferIndex < 0)
                    throw new Exception("Node says it contains geometry but index buffer pointer is not set");
                if (node.Brother != null)
                    throw new Exception("An identical brother exists, this node was supposed to be removed");
            }
        }

        public void PrintScene()
        {
            if(_buffers.Nodes.Count > 500)
                Console.WriteLine("Scene to large to print");
            foreach (var node in _buffers.Nodes)
            {
                Console.WriteLine(node);
            }
        }

        public void RebuildNodeBufferFromRoot()
        {

            var root = _buffers.Nodes[_buffers.RootNode];
            foreach (var t in _buffers.Nodes)
            {
                t.Index = -1;
            }
            root.Index = 0;
            BuildListRecursive(root, 1);

            var arr = new SceneNode[_buffers.Nodes.Count];
            foreach (var node in _buffers.Nodes)
            {
                arr[node.Index] = node;
            }

            _buffers.RootNode = 0;
            _buffers.Nodes.Clear();
            _buffers.Nodes.AddRange(arr);
        }
        // use DFS Layout since this also the way traversal is done, should improve caching
        private int BuildListRecursive(SceneNode node, int indexOffset)
        {
            if (!node.Children.Any())
                return indexOffset;

            int start = indexOffset;

            foreach (var child in node.Children)
            {
                if (child.Index < 0)
                {
                    child.Index = indexOffset;
                    indexOffset++;
                }
            }

            if (start == indexOffset) return indexOffset; // all were already added
            // call for all children
            // TODO might want to avoid calling twice for a node
            foreach (var child in node.Children) 
            {
                indexOffset = BuildListRecursive(child, indexOffset);
            }

            return indexOffset;
        }

        private void DepthRecursion(SceneNode node)
        {
            foreach (var child in node.Children)
            {
                child.Level = Math.Max(node.Level + 1, child.Level);
                DepthRecursion(child);
            }
        }

        public void ComputeAABBs(SceneNode node)
        {
            foreach (var child in node.Children) // children
            {
                ComputeAABBs(child);
                var (min, max) = TransformAABB(child.ObjectToWorld, child.AABB_min, child.AABB_max);
                node.AABB_min = Min(node.AABB_min, min);
                node.AABB_max = Max(node.AABB_max, max);
            }

            for (var i = 0; i < node.NumTriangles; i++)
            {
                var index = node.IndexBufferIndex + i * 3;
                for (var j = 0; j < 3; j++)
                {
                    var v = _buffers.VertexBuffer[(int)_buffers.IndexBuffer[index + j]];
                    var pos = new Vector4(v.Position[0], v.Position[1], v.Position[2], 1);
                    node.AABB_min = Min(node.AABB_min, pos);
                    node.AABB_max = Max(node.AABB_max, pos);
                }
            }
        }

        private (Vector4 min, Vector4 max) TransformAABB(Matrix4x4 transform, Vector4 min, Vector4 max)
        {
            Vector4[] aabbVertices ={
                new (min.X,min.Y,min.Z,1),
                new (min.X,min.Y,max.Z,1),
                new (min.X,max.Y,min.Z,1),
                new (min.X,max.Y,max.Z,1),
                new (max.X,min.Y,min.Z,1),
                new (max.X,min.Y,max.Z,1),
                new (max.X,max.Y,min.Z,1),
                new (max.X,max.Y,max.Z,1)
            };

            min = new(float.MaxValue, float.MaxValue, float.MaxValue, 1);
            max = new(-float.MaxValue, -float.MaxValue, -float.MaxValue, 1);

            foreach (var vert in aabbVertices)
            {
                var vec = Vector4.Transform(vert, transform);
                min = Min(min, vec);
                max = Max(max, vec);
            }
            return (min, max);
        }

        private Vector4 Max(Vector4 a, Vector4 b)
        {
            return new Vector4(
                Math.Max(a.X, b.X),
                Math.Max(a.Y, b.Y),
                Math.Max(a.Z, b.Z),
                1);
        }
        private Vector4 Min(Vector4 a, Vector4 b)
        {
            return new Vector4(
                Math.Max(a.X, b.X),
                Math.Max(a.Y, b.Y),
                Math.Max(a.Z, b.Z),
                1);
        }


        private void SingleLevel()
        {
            // collapse parent nodes
        }
    }
}