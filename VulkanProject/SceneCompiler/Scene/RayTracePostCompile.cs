﻿using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
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
            Console.WriteLine("Adjusting Scene Graph");
            var buffer = _buffers.Nodes;
            SceneNode root = buffer[_buffers.RootNode];
            root.Level = 0;
            Console.WriteLine("Merge instance Lists");
            MergeInstanceList();
            Console.WriteLine("Ensure Device Limitations");
            CapInstanceLists();

            Console.WriteLine("Writing Levels");
            DepthRecursion(root);
            Console.WriteLine("Number of Triangles: " + root.TotalPrimitiveCount);
            Console.WriteLine("Removing empty children");
            Parallel.ForEach(buffer, x => x.Children = x.Children.Where(x => x.TotalPrimitiveCount > 0).ToList());

            List<SceneNode> blasAdd = new();
            List<SceneNode> tlasAdd = new();
            Console.WriteLine("inserting dummys");
            var evenTask = Task.Run(() =>
            {
                foreach (var node in buffer.Where(x => x.Level % 2 == 0))
                    AdjustEvenNode(node, blasAdd);
            });

            var oddTask = Task.Run(() =>
            {
                foreach (var node in buffer.Where(x => x.Level % 2 == 1))
                    AdjustOddNode(node, tlasAdd);
            });

            evenTask.Wait();
            oddTask.Wait();

            buffer.AddRange(tlasAdd);
            buffer.AddRange(blasAdd);


            Console.WriteLine("added " + (tlasAdd.Count +blasAdd.Count) + " dummies to the scenegraph");

            for (var i = 0; i < buffer.Count; i++)
            {
                buffer[i].Index = i;
                buffer[i].NumChildren = buffer[i].Children.Count;
            }
            Console.WriteLine("computing AABBs");
            foreach (var node in _buffers.Nodes)
                node.ResetAABB();
            root.ComputeAABBs(_buffers);
        }

        private void MergeInstanceList()
        {
            Console.WriteLine("Merging instance Lists");
            var add = new List<SceneNode>();

            foreach (var node in _buffers.Nodes)
            {
                if(node.Children.Count(x=>x.IsInstanceList) > 1)
                {
                    bool merge = true;
                    // every instance list must have the same transfrom, ie all use identity(cause thats convenient)
                    foreach (var child in node.Children.Where(x => x.IsInstanceList))
                    {
                        if (!SceneNode.MatrixAlmostZero(child.ObjectToWorld - Matrix4x4.Identity))
                        {
                            merge = false;
                            break;
                        }
                    }
                    if (!merge)
                        continue;

                    // every parent that references these lists must reference exactly these lists and none else
                    // (could be better, but unimportant for now)
                    var parents = node.Children.SelectMany(x => x.Parents).Distinct().ToList();
                    foreach(var parent in parents)
                    {
                        if(!ListEqual(parent.Children.Where(x=>x.IsInstanceList), node.Children.Where(x => x.IsInstanceList))){
                            merge = false;
                            break;
                        }
                    }
                    if (!merge)
                        continue;
                    // do the actual merge by inserting all children into the frist instance list and removing the others from the childChain
                    var first = node.Children.First(x => x.IsInstanceList);
                    var children = node.Children.SelectMany(x => x.Children).ToList();
                    foreach(var child in children)
                    {
                        child.Parents.Clear();
                        child.Parents.Add(first);
                    }
                    foreach(var list in node.Children.Where(x => x.IsInstanceList))
                    {
                        list.Children.Clear();
                    }
                    first.Children.Clear();
                    first.Children = children;
                    foreach(var parent in parents)
                    {
                        parent.Children.RemoveAll(x => x.IsInstanceList);
                        parent.Children.Add(first);
                    }
                    first.Name += " Merge " + children.Count();
                }
            }
        }

        private bool ListEqual<T>(IEnumerable<T> list1, IEnumerable<T> list2)
        {
            if (list1.Count() != list2.Count())
                return false;
            foreach(var a in list1)
            {
                if (!list2.Contains(a))
                    return false;
            }
            foreach(var b in list2)
            {
                if (!list1.Contains(b))
                    return false;
            }
            return true;
        }

        public void AdjustEvenNode(SceneNode node, List<SceneNode> blasAdd)
        {
            List<SceneNode> evenChildren = new();
            List<SceneNode> oddChildren = new();
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

            if (node.NumTriangles > 0 || evenChildren.Count > 0)
            {
                bool selector(SceneNode x)
                {
                    if (x.Children.Count != evenChildren.Count)
                        return false;
                    foreach (var child in evenChildren)
                    {
                        if (!x.Children.Contains(child))
                            return false;
                    }
                    foreach (var child in x.Children)
                    {
                        if (!evenChildren.Contains(child))
                            return false;
                    }
                    if (x.IndexBufferIndex != node.IndexBufferIndex)
                        return false;
                    if (x.NumTriangles != node.NumTriangles)
                        return false;

                    return true;
                }
                var dummy = blasAdd.Where(selector).SingleOrDefault();
                if(dummy == null)
                {
                    dummy = new SceneNode
                    {
                        // set new Level and index
                        Level = node.Level + 1,
                        Name = "DummyBLAS",
                        // add the geometry
                        IndexBufferIndex = node.IndexBufferIndex,
                        NumTriangles = node.NumTriangles,
                        // add the even children
                        NumChildren = evenChildren.Count,
                        Children = new List<SceneNode>(evenChildren),
                        // set transforms to identity
                        ObjectToWorld = Matrix4x4.Identity,
                    };
                    blasAdd.Add(dummy);
                }
                // add odd dummy to buffer and to children of the even node
                oddChildren.Add(dummy);
                // removed geometry
                node.IndexBufferIndex = -1;
                node.NumTriangles = 0;

                // add only the odd children
                node.Children.Clear();
                node.Children.AddRange(oddChildren);
                node.NumChildren = oddChildren.Count;
            }
        }

        public void AdjustOddNode(SceneNode node, List<SceneNode> tlasAdd)
        {
            List<SceneNode> evenChildren = new();
            List<SceneNode> oddChildren = new();
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

            if (oddChildren.Count > 0)
            {
                // we solve this by building a new tlas for this reference
                // but this can happen multiple times for the same blas
                // so if possible we want to reuse the tlas
                var dummy = tlasAdd.Where(x =>
                {
                    if (x.Children.Count != oddChildren.Count)
                        return false;
                    foreach (var child in oddChildren)
                    {
                        if (!x.Children.Contains(child))
                            return false;
                    }
                    foreach(var child in x.Children)
                    {
                        if(!oddChildren.Contains(child))
                            return false;
                    }

                    return true;
                }).SingleOrDefault();

                if (dummy == null)
                {
                    dummy = new SceneNode
                    {
                        // set new Level and index
                        Level = node.Level + 1,
                        Name = "DummyTLAS",
                        // add the odd children
                        NumChildren = oddChildren.Count,
                        Children = new List<SceneNode>(oddChildren),
                        // set transforms to identity
                        ObjectToWorld = Matrix4x4.Identity,
                    };
                    tlasAdd.Add(dummy);
                }

                // add even dummy to buffer and children of the odd node
                evenChildren.Add(dummy);

                // add only the even children
                node.Children.Clear();
                node.Children.AddRange(evenChildren);
                node.NumChildren = evenChildren.Count;
            }
            else
            {
                // we only want and only have even children, therefore set numEven
            }
        }

        public void Validate()
        {
            Console.WriteLine("Validating SceneGraph");
            Parallel.ForEach(_buffers.Nodes, node =>
           {
               if (node.Level < 0)
                   throw new Exception("Level was not set");
               foreach (var child in node.Children)
               {
                   if (child.Level <= node.Level)
                       throw new Exception("Child level must always be at least one higher than parent");
                   if (child.Level + node.Level % 2 == 0)
                       throw new Exception("Either two odd levels or two even levels are parent and child");
               }

               if (node.IsInstanceList)
               {
                   if (node.Level % 2 == 1)
                       throw new Exception("instance List must have even level");
                   if (node.NumTriangles > 0)
                       throw new Exception("instance List can not contain geometry");

                   if (node.Children.Count != 1)
                       throw new Exception("instance List must have exactly one child (DummyBLAS)");

                   var dummyBLAS = node.Children[0];

                   if (dummyBLAS.Name != "DummyBLAS")
                       throw new Exception("child of instancle List is not a dummyTLAS");

                   foreach (var child in dummyBLAS.Children)
                   {
                       if (child.Level % 2 == 1)
                           throw new Exception("Instance list elements must have an even level");
                       if (child.NumTriangles > 0)
                           throw new Exception("Instance list elements can not reference triangles");
                       foreach (var parent in child.Parents)
                       {
                           if (parent.Name != "DummyBLAS")
                               throw new Exception("Parent of instance list element must be DummyBLAS");
                           foreach (var grandParent in parent.Parents)
                           {
                               if (!grandParent.IsInstanceList)
                                   throw new Exception("Grandparent of instance list element must be instance list");
                           }
                       }
                   }
               }

               if (node.Index < 0)
                   throw new Exception("Index was not set");
               if (_buffers.Nodes[node.Index] != node)
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
           });
        }

        public void PrintScene()
        {
            foreach (var node in _buffers.Nodes)
            {
                if (node.Name.Contains("Dummy") && node.Parents[0].IsInstanceList)
                    continue;
                var str = node.ToString();
                if (str.Contains("Mesh"))
                    continue;
                if (str.Contains("Inst") && !str.Contains("List"))
                    continue;
                Console.WriteLine(str);
            }
        }

        public void RebuildNodeBufferFromRoot()
        {
            Console.WriteLine("Rebuilding the buffer from the root");
            var root = _buffers.Nodes[_buffers.RootNode];
            Parallel.ForEach(_buffers.Nodes, t =>
            {
                t.Index = -1;
                t.Parents.Clear();
            });
            root.Index = 0;
            BuildListRecursive(root, 1);

            var arr = new SceneNode[_buffers.Nodes.Count(x=>x.Index != -1)];
            var unused = 0;
            foreach (var node in _buffers.Nodes)
            {
                if(node.Index == -1)
                {
                    unused++;
                    continue;
                }
                arr[node.Index] = node;
            }

            Console.WriteLine("Removed " + unused + " unused Nodes");

            _buffers.RootNode = 0;
            _buffers.Nodes.Clear();
            _buffers.Nodes.AddRange(arr);

            foreach (var node in _buffers.Nodes)
            {
                foreach (var child in node.Children)
                {
                    child.Parents.Add(node);
                }
            }
        }
        // use DFS Layout since this also the way traversal is done, should improve caching
        private int BuildListRecursive(SceneNode node, int indexOffset)
        {
            
            if (!node.Children.Any())
                return indexOffset;

            int start = indexOffset;

            if (node.IsInstanceList)
            {
                if (node.Children[0].Index < 0)
                {
                    node.Children[0].Index = indexOffset;
                    indexOffset++;
                    node = node.Children[0];
                }
            }
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
                if (node.Level >= child.Level)
                {
                    child.Level = node.Level + 1;
                    if (child.ForceOdd && child.Level % 2 == 0)
                        child.Level++;
                    if (child.ForceEven && child.Level % 2 == 1)
                        child.Level++;
                    DepthRecursion(child);
                }
            }
            node.TotalPrimitiveCount = node.NumTriangles + node.Children.Sum(x => x.TotalPrimitiveCount);
        }

        private void SingleLevel()
        {
            // collapse parent nodes
        }

        public void CapInstanceLists()
        {
            var max = 1 << 22; // 23
            var root = _buffers.Nodes[_buffers.RootNode];
            var toSplit = new List<SceneNode>();
            foreach(var node in _buffers.Nodes)
            {
                if (node.IsInstanceList && node.Children.Count > max)
                {
                    toSplit.Add(node);
                }
            }

            while (toSplit.Any())
            {
                var left = toSplit[^1];
                toSplit.RemoveAt(toSplit.Count - 1);
                left.ComputeAABBs(_buffers);
                var (leftChildren, rightChildren) = SplitNodes(left);

                var right = new SceneNode
                {
                    ForceEven = left.ForceEven,
                    ForceOdd = left.ForceOdd,
                    IsLodSelector = left.IsLodSelector,
                    IsInstanceList = left.IsInstanceList,
                    Parents = left.Parents,
                    Children = rightChildren,
                    ObjectToWorld = left.ObjectToWorld,
                    Name = "R" + left.Name,
                    NumChildren = rightChildren.Count
                };

                left.Name = "L" + left.Name;
                left.Children = leftChildren;
                left.NumChildren = leftChildren.Count;

                foreach (var parent in left.Parents)
                {
                    parent.Children.Add(right);
                }

                foreach(var child in rightChildren)
                {
                    child.Parents.Remove(left);
                    child.Parents.Add(right);
                }

                _buffers.Nodes.Add(right);

                if (left.IsInstanceList && left.Children.Count > max)
                    toSplit.Add(left);
                if (right.IsInstanceList && right.Children.Count > max)
                    toSplit.Add(right);
                left.ResetAABB();
                right.ResetAABB();
            }

            foreach(var node in _buffers.Nodes)
            {
                node.ResetAABB();
            }
        }

        private (List<SceneNode> left, List<SceneNode> right) SplitNodes(SceneNode node)
        {
            var left = new List<SceneNode>(node.Children.Count / 2 + 10);
            var right = new List<SceneNode>(node.Children.Count / 2 + 10);


            double medX = 0;
            double medY = 0;
            double medZ = 0;
            foreach(var child in node.Children)
            {
                var middle = (child.AABB_max + child.AABB_min) / 2;
                medX += middle.X;
                medY += middle.Y;
                medZ += middle.Z;
            }
            medX = medX / node.Children.Count;
            medY = medY / node.Children.Count;
            medZ = medZ / node.Children.Count;

            var extent = node.AABB_max - node.AABB_min;

            int axis = 0;
            double split = medX;
            if(extent.Y> extent.X || extent.Z > extent.X)
            {
                if (extent.Y > extent.Z)
                {
                    axis = 1;
                    split = medY;
                }
                else
                {
                    axis = 2;
                    split = medZ;
                }
            }

            foreach(var child in node.Children)
            {
                var middle = (child.AABB_max + child.AABB_min) / 2;
                double value = 0;
                if (axis == 0) value = middle.X;
                if (axis == 1) value = middle.Y;
                if (axis == 2) value = middle.Z;
                if (value < split)
                    left.Add(child);
                else
                    right.Add(child);
            }
            return (left, right);
        }
    }
}